import { describe, expect, it } from "vitest";
import { clampPan, FIT, MAX_ZOOM, toggleZoom, wheelFactor, zoomTo } from "./zoom";

describe("zoomTo", () => {
  it("keeps the point under the cursor in place", () => {
    const at = { x: 100, y: -50 };
    const view = zoomTo(FIT, 2, at);
    expect(view).toEqual({ scale: 2, x: -100, y: 50 });
    // The image point that was under `at` (100, -50 at 1×) is still under it.
    expect(view.x + 100 * view.scale).toBe(at.x);
  });

  it("stays between fit and the maximum, and re-centers at fit", () => {
    expect(zoomTo(FIT, 99).scale).toBe(MAX_ZOOM);
    expect(zoomTo({ scale: 3, x: 40, y: 40 }, 0.5)).toEqual(FIT);
  });
});

describe("toggleZoom", () => {
  it("zooms in on the tapped spot, then back to fit", () => {
    const zoomed = toggleZoom(FIT, { x: 10, y: 10 });
    expect(zoomed.scale).toBe(2.5);
    expect(toggleZoom(zoomed, { x: 0, y: 0 })).toEqual(FIT);
  });
});

describe("clampPan", () => {
  it("lets a zoomed image move only until its edge meets the viewport's", () => {
    const image = { width: 400, height: 300 };
    const viewport = { width: 400, height: 300 };
    expect(clampPan({ scale: 2, x: 999, y: -999 }, image, viewport)).toEqual({
      scale: 2,
      x: 200,
      y: -150,
    });
    // Smaller than the viewport: no panning.
    expect(clampPan({ scale: 1, x: 50, y: 50 }, { width: 100, height: 100 }, viewport)).toEqual(
      FIT,
    );
  });
});

describe("wheelFactor", () => {
  it("zooms in on wheel up, out on wheel down", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });
});
