import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ATTACHMENT_CACHE_CONTROL,
  isInlineAttachment,
  PRESIGN_GET_EXPIRES_SECONDS,
  PRESIGN_GET_WINDOW_SECONDS,
  PRESIGN_PUT_EXPIRES_SECONDS,
  type Attachment,
  type Message,
} from "@mindfultech/shared";
import { requireEnv } from "./env";

const s3 = new S3Client({});

/**
 * Upload URL; the signature pins Content-Type, Content-Length and
 * Cache-Control, so the object can only be exactly the size the server
 * accepted (≤ MAX_ATTACHMENT_SIZE, checked by the presign schema): the PUT
 * equivalent of a POST policy's content-length-range. The client must send
 * `Cache-Control: ATTACHMENT_CACHE_CONTROL`, which S3 stores on the object.
 * Valid for 30 minutes: 500 MB takes a while.
 */
export function presignPut(key: string, contentType: string, size: number): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: requireEnv("ATTACHMENTS_BUCKET"),
      Key: key,
      ContentType: contentType,
      ContentLength: size,
      CacheControl: ATTACHMENT_CACHE_CONTROL,
    }),
    {
      expiresIn: PRESIGN_PUT_EXPIRES_SECONDS,
      signableHeaders: new Set(["content-type", "content-length", "cache-control"]),
    },
  );
}

/** Start of the signing window `at` falls in (see `PRESIGN_GET_WINDOW_SECONDS`). */
export function signingWindowStart(at = Date.now()): Date {
  const windowMs = PRESIGN_GET_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(at / windowMs) * windowMs);
}

/**
 * Download URL, signed as of the start of the current window so every URL for
 * `key` minted in that window is identical (same `X-Amz-Date`, same expiry,
 * same signature) and the browser cache keeps hitting. Valid until
 * `PRESIGN_GET_EXPIRES_SECONDS` after the window started. One caveat: the
 * signature also depends on the Lambda's own session credentials, so two
 * execution environments can mint different (equally valid) URLs.
 */
export function presignGet(key: string, now = Date.now()): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: requireEnv("ATTACHMENTS_BUCKET"), Key: key }),
    { expiresIn: PRESIGN_GET_EXPIRES_SECONDS, signingDate: signingWindowStart(now) },
  );
}

/**
 * `Content-Disposition: attachment` for `name`: an ASCII `filename` for old
 * browsers (anything else, quotes and backslashes become `_`) and the exact
 * name in RFC 5987 `filename*`. Nothing from `name` reaches the header
 * unescaped, so it can't break out of it.
 */
export function attachmentDisposition(name: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_").trim() || "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Download URL that saves the file as `name` rather than showing it (Phase
 * 47): S3 answers with `Content-Disposition: attachment`, the one thing a
 * browser honours on another origin (it ignores `<a download>` there).
 * Signed in the same windows as `presignGet`.
 */
export function presignDownload(key: string, name: string, now = Date.now()): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: requireEnv("ATTACHMENTS_BUCKET"),
      Key: key,
      ResponseContentDisposition: attachmentDisposition(name),
    }),
    { expiresIn: PRESIGN_GET_EXPIRES_SECONDS, signingDate: signingWindowStart(now) },
  );
}

/** `attachment` with `url` (and `thumbUrl`) when it's shown inline; other files are left alone. */
export async function withSignedUrls(attachment: Attachment, now?: number): Promise<Attachment> {
  if (!isInlineAttachment(attachment)) return attachment;
  const [url, thumbUrl] = await Promise.all([
    presignGet(attachment.key, now),
    attachment.thumbKey ? presignGet(attachment.thumbKey, now) : undefined,
  ]);
  return { ...attachment, url, ...(thumbUrl && { thumbUrl }) };
}

/** `message` as sent to clients: its inline attachments carry download URLs. */
export async function signAttachments(message: Message, now?: number): Promise<Message> {
  if (!message.attachments?.length) return message;
  return {
    ...message,
    attachments: await Promise.all(message.attachments.map((a) => withSignedUrls(a, now))),
  };
}

/**
 * Whether `key` exists. Relies on s3:ListBucket being granted: without it S3
 * answers 403 instead of 404 for missing keys.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: requireEnv("ATTACHMENTS_BUCKET"), Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if ((err instanceof Error && err.name === "NotFound") || status === 404) return false;
    throw err;
  }
}

/** DeleteObjects takes at most 1,000 keys. */
const DELETE_BATCH = 1000;

/**
 * Deletes the objects `keys` from the attachments bucket (Phase 32: a deleted
 * message's files, a deleted board's). Missing keys are fine. Throws if S3
 * reports any key it couldn't delete, so callers can log or retry.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += DELETE_BATCH) {
    batches.push(unique.slice(i, i + DELETE_BATCH));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      s3.send(
        new DeleteObjectsCommand({
          Bucket: requireEnv("ATTACHMENTS_BUCKET"),
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      ),
    ),
  );
  const errors = results.flatMap((r) => r.Errors ?? []);
  if (errors.length > 0) {
    throw new Error(`Couldn't delete ${errors.length} objects (first: ${errors[0]?.Key})`);
  }
}

/** Deletes every object under `prefix` (a board's `attachments/<boardId>/`); returns how many. */
export async function deletePrefix(prefix: string): Promise<number> {
  const keys: string[] = [];
  for await (const page of paginateListObjectsV2(
    { client: s3 },
    { Bucket: requireEnv("ATTACHMENTS_BUCKET"), Prefix: prefix },
  )) {
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
  }
  await deleteObjects(keys);
  return keys.length;
}
