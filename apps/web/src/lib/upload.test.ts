import { MAX_ATTACHMENT_SIZE } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const presign = vi.fn();
vi.mock("./chat", () => ({ chat: { presign: (...args: unknown[]) => presign(...args) } }));
import {
  formatBytes,
  getDownloadUrl,
  isUsableUrl,
  MAX_SIZE_LABEL,
  presignedUrlExpiry,
  rememberDownloadUrl,
  thumbnailName,
  validateFile,
} from "./upload";

const signed = (key: string, date: string, expires: number) =>
  `https://b.s3.amazonaws.com/${key}?X-Amz-Date=${date}&X-Amz-Expires=${expires}&X-Amz-Signature=abc`;

describe("validateFile", () => {
  it("accepts anything up to 500 MB and refuses more, before any request", () => {
    expect(MAX_ATTACHMENT_SIZE).toBe(500 * 1024 * 1024);
    expect(MAX_SIZE_LABEL).toBe("500 MB");
    expect(validateFile({ size: 1 })).toBeNull();
    expect(validateFile({ size: MAX_ATTACHMENT_SIZE })).toBeNull();
    expect(validateFile({ size: MAX_ATTACHMENT_SIZE + 1 })).toBe("File must be under 500 MB.");
    expect(validateFile({ size: 0 })).toBe("The file is empty.");
  });

  it("formats sizes for the upload rows", () => {
    expect(formatBytes(400 * 1024 * 1024)).toBe("400.0 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("names thumbnails after the original", () => {
    expect(thumbnailName("mi foto.PNG", "image/webp")).toBe("thumb-mi foto.webp");
    expect(thumbnailName("photo.jpeg", "image/jpeg")).toBe("thumb-photo.jpg");
    expect(thumbnailName(".png", "image/webp")).toBe("thumb-image.webp");
  });
});

describe("download URLs", () => {
  const T = Date.UTC(2026, 10, 3, 14, 30);
  beforeEach(() => {
    presign.mockReset();
    vi.useFakeTimers({ now: T, toFake: ["Date"] });
  });

  it("reads a presigned URL's expiry from its query string", () => {
    expect(presignedUrlExpiry(signed("k", "20261103T140000Z", 10800))).toBe(
      Date.UTC(2026, 10, 3, 17, 0),
    );
    expect(presignedUrlExpiry("https://x/y")).toBe(0);
    expect(presignedUrlExpiry("not a url")).toBe(0);
    expect(isUsableUrl(signed("k", "20261103T140000Z", 10800))).toBe(true);
    expect(isUsableUrl(signed("k", "20261103T140000Z", 1860))).toBe(false); // expires in 1 min
    expect(isUsableUrl(undefined)).toBe(false);
  });

  it("uses the URL the server attached while it's good, and asks only when it isn't", async () => {
    const fresh = signed("attachments/c/a.png", "20261103T140000Z", 10800);
    expect(await getDownloadUrl("attachments/c/a.png", fresh)).toBe(fresh);
    expect(presign).not.toHaveBeenCalled();

    // Remembered from a message: a later lookup without the URL still needs no request.
    rememberDownloadUrl("attachments/c/b.png", fresh.replace("a.png", "b.png"));
    expect(await getDownloadUrl("attachments/c/b.png")).toContain("b.png");
    expect(presign).not.toHaveBeenCalled();

    // Stale: one presign, then cached until its own expiry.
    const stale = signed("attachments/c/c.png", "20261103T100000Z", 10800);
    const minted = signed("attachments/c/c.png", "20261103T140000Z", 10800);
    presign.mockResolvedValueOnce({ url: minted, key: "attachments/c/c.png" });
    expect(await getDownloadUrl("attachments/c/c.png", stale)).toBe(minted);
    expect(await getDownloadUrl("attachments/c/c.png")).toBe(minted);
    expect(presign).toHaveBeenCalledTimes(1);
    expect(presign).toHaveBeenCalledWith({ op: "get", key: "attachments/c/c.png" });
  });
});
