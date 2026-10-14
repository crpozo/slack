import { MAX_ATTACHMENT_SIZE } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import { formatBytes, MAX_SIZE_LABEL, validateFile } from "./upload";

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
});
