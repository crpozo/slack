import { describe, expect, it } from "vitest";
import { pageLabel, pdfRenderer, PDF_MAX_PIXEL_RATIO } from "./pdf";

describe("which PDF viewer a device gets", () => {
  it("iPhones, iPads and every touch-first device draw the pages on canvas", () => {
    expect(pdfRenderer({ ios: true })).toBe("canvas");
    expect(pdfRenderer({ coarsePointer: true })).toBe("canvas");
    expect(pdfRenderer({ android: true })).toBe("canvas");
  });

  it("computers keep the browser's own viewer", () => {
    expect(pdfRenderer({ ios: false, coarsePointer: false, android: false })).toBe("native");
  });

  it("labels pages and caps the canvas resolution for iOS's memory budget", () => {
    expect(pageLabel(3, 12)).toBe("3 / 12");
    expect(PDF_MAX_PIXEL_RATIO).toBeLessThanOrEqual(2);
  });
});
