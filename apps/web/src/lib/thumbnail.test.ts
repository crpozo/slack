import { describe, expect, it } from "vitest";
import { canThumbnail, describeImage, fitWithin } from "./thumbnail";

describe("thumbnails", () => {
  it("fits the longest side into 1280 without upscaling", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(1000, 3000)).toEqual({ width: 427, height: 1280 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1280, 1280)).toEqual({ width: 1280, height: 1280 });
    expect(fitWithin(5000, 1, 100)).toEqual({ width: 100, height: 1 });
  });

  it("only previews formats a canvas can decode", () => {
    expect(canThumbnail("image/jpeg")).toBe(true);
    expect(canThumbnail("image/webp")).toBe(true);
    expect(canThumbnail("image/svg+xml")).toBe(false);
    expect(canThumbnail("image/heic")).toBe(false);
    expect(canThumbnail("application/pdf")).toBe(false);
  });

  it("gives up quietly without a DOM", async () => {
    expect(await describeImage(new Blob(["x"], { type: "image/png" }))).toBeNull();
  });
});
