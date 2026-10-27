import {
  ATTACHMENT_CACHE_CONTROL,
  MAX_ATTACHMENT_SIZE,
  type Attachment,
} from "@mindfultech/shared";
import { chat } from "./chat";
import { UploadTask } from "./outbox";
import { describeImage } from "./thumbnail";

export const MAX_SIZE_LABEL = "500 MB";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Client-side check before asking for a URL; `null` when the file is acceptable. */
export function validateFile(file: Pick<File, "size">): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_ATTACHMENT_SIZE) return `File must be under ${MAX_SIZE_LABEL}.`;
  return null;
}

/** PUT with progress (fetch can't report upload progress). */
function put(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    // Signed into the URL: S3 stores it, browsers keep the (immutable) object.
    xhr.setRequestHeader("Cache-Control", ATTACHMENT_CACHE_CONTROL);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    xhr.send(file);
  });
}

/** The thumbnail's file name next to the original's: `thumb-<name>.webp`. */
export function thumbnailName(name: string, contentType: string): string {
  const base = name.replace(/\.[^.]+$/, "").slice(-200) || "image";
  return `thumb-${base}.${contentType === "image/jpeg" ? "jpg" : "webp"}`;
}

/**
 * presign → PUT straight to S3 → attachment ready to send with a message.
 * Images are measured first and, when large, a downscaled copy goes up next
 * to the original (`thumbKey`): the list shows that, the viewer the original.
 */
export async function uploadFile(
  file: File,
  channelId: string,
  onProgress: (fraction: number) => void = () => {},
): Promise<Attachment> {
  const invalid = validateFile(file);
  if (invalid) throw new Error(invalid);

  const contentType = file.type || "application/octet-stream";
  const name = file.name.slice(-255) || "file";
  const image = contentType.startsWith("image/") ? await describeImage(file) : null;
  const { url, key } = await chat.presign({
    op: "put",
    channelId,
    name,
    contentType,
    size: file.size,
  });
  // The original carries the progress bar; the thumbnail is a small extra at the end.
  const thumb = image?.thumbnail;
  const share = thumb ? 0.95 : 1;
  await put(url, file, contentType, (p) => onProgress(p * share));
  const attachment: Attachment = { key, name, size: file.size, contentType };
  if (image) {
    attachment.width = thumb?.width ?? image.width;
    attachment.height = thumb?.height ?? image.height;
  }
  if (thumb) {
    try {
      const signed = await chat.presign({
        op: "put",
        channelId,
        name: thumbnailName(name, thumb.contentType),
        contentType: thumb.contentType,
        size: thumb.blob.size,
      });
      await put(signed.url, thumb.blob, thumb.contentType, () => {});
      attachment.thumbKey = signed.key;
    } catch {
      // No preview, but the original is up: the list falls back to it.
    }
  }
  onProgress(1);
  return attachment;
}

/**
 * Starts uploading a file for a message (Phase 39): the composer shows its
 * progress, the outbox awaits it when the message is sent. `extra` goes on
 * the attachment too (a voice note's `durationMs`).
 */
export function startUpload(
  file: File,
  channelId: string,
  extra: Partial<Attachment> = {},
): UploadTask {
  return new UploadTask(file, (onProgress) => uploadFile(file, channelId, onProgress), extra);
}

const downloadUrls = new Map<string, { url: string; expiresAt: number }>();
/** Don't hand out a URL about to expire: the image may still be loading when it does. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

/** When a presigned S3 URL stops working (epoch ms), from its `X-Amz-Date` and `X-Amz-Expires`. */
export function presignedUrlExpiry(url: string): number {
  try {
    const params = new URL(url).searchParams;
    const date = params.get("X-Amz-Date");
    const expires = Number(params.get("X-Amz-Expires"));
    const m = date && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
    if (!m || !Number.isFinite(expires)) return 0;
    const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
    return Date.UTC(y!, mo! - 1, d, h, mi, s) + expires * 1000;
  } catch {
    return 0;
  }
}

/** Still good for a while: the signature won't expire mid-download. */
export const isUsableUrl = (url: string | undefined, now = Date.now()): url is string =>
  !!url && presignedUrlExpiry(url) - EXPIRY_MARGIN_MS > now;

/** Remembers a URL the server attached to a message, so a later lookup needs no request. */
export function rememberDownloadUrl(key: string, url: string | undefined): void {
  if (!url) return;
  const expiresAt = presignedUrlExpiry(url);
  if (expiresAt > Date.now()) downloadUrls.set(key, { url, expiresAt });
}

/**
 * Signed GET URL: the one the server attached to the message when it's still
 * good, else the cached one, else a `presign` request. URLs are signed per
 * 2-hour window, so the browser cache keeps hitting while the window lasts.
 */
export async function getDownloadUrl(key: string, known?: string): Promise<string> {
  if (isUsableUrl(known)) return known;
  const cached = downloadUrls.get(key);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.url;
  const { url } = await chat.presign({ op: "get", key });
  downloadUrls.set(key, { url, expiresAt: presignedUrlExpiry(url) || Date.now() + 60_000 });
  return url;
}
