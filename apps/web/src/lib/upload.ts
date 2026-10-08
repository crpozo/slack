import { MAX_ATTACHMENT_SIZE, type Attachment } from "@mindfultech/shared";
import { chat } from "./chat";

export const MAX_SIZE_LABEL = "25 MB";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Client-side check before asking for a URL; `null` when the file is acceptable. */
export function validateFile(file: Pick<File, "size">): string | null {
  if (file.size === 0) return "El archivo está vacío.";
  if (file.size > MAX_ATTACHMENT_SIZE) return `El archivo supera el límite de ${MAX_SIZE_LABEL}.`;
  return null;
}

/** PUT with progress (fetch can't report upload progress). */
function put(
  url: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`La subida falló (HTTP ${xhr.status}).`));
    xhr.onerror = () => reject(new Error("La subida falló. Revisa tu conexión."));
    xhr.send(file);
  });
}

/** presign → PUT straight to S3 → attachment ready to send with a message. */
export async function uploadFile(
  file: File,
  channelId: string,
  onProgress: (fraction: number) => void = () => {},
): Promise<Attachment> {
  const invalid = validateFile(file);
  if (invalid) throw new Error(invalid);

  const contentType = file.type || "application/octet-stream";
  const name = file.name.slice(-255) || "archivo";
  const { url, key } = await chat.presign({
    op: "put",
    channelId,
    name,
    contentType,
    size: file.size,
  });
  await put(url, file, contentType, onProgress);
  onProgress(1);
  return { key, name, size: file.size, contentType };
}

const downloadUrls = new Map<string, { url: string; expiresAt: number }>();

/** Signed GET URL, cached for a bit less than its 5-minute lifetime. */
export async function getDownloadUrl(key: string): Promise<string> {
  const cached = downloadUrls.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { url } = await chat.presign({ op: "get", key });
  downloadUrls.set(key, { url, expiresAt: Date.now() + 4 * 60 * 1000 });
  return url;
}
