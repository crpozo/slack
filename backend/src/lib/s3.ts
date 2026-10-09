import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGN_EXPIRES_SECONDS } from "@mindfultech/shared";
import { requireEnv } from "./env";

const s3 = new S3Client({});

/** Upload URL; the signature pins Content-Type and Content-Length. */
export function presignPut(key: string, contentType: string, size: number): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: requireEnv("ATTACHMENTS_BUCKET"),
      Key: key,
      ContentType: contentType,
      ContentLength: size,
    }),
    {
      expiresIn: PRESIGN_EXPIRES_SECONDS,
      signableHeaders: new Set(["content-type", "content-length"]),
    },
  );
}

export function presignGet(key: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: requireEnv("ATTACHMENTS_BUCKET"), Key: key }),
    {
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    },
  );
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
