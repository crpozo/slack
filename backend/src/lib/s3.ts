import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
