import { describe, expect, it } from "vitest";
import {
  BOTTOM_MARGIN,
  clampToViewport,
  cornerAfterKey,
  cornerPosition,
  EDGE_MARGIN,
  nearestCorner,
} from "./floating";

const viewport = { width: 1000, height: 800 };

describe("floating call window geometry", () => {
  it("snaps to the corner nearest the window's center", () => {
    expect(nearestCorner(100, 100, 1000, 800)).toBe("top-left");
    expect(nearestCorner(900, 100, 1000, 800)).toBe("top-right");
    expect(nearestCorner(100, 700, 1000, 800)).toBe("bottom-left");
    expect(nearestCorner(600, 500, 1000, 800)).toBe("bottom-right");
  });

  it("parks the window inside the margins, clear of the composer at the bottom", () => {
    expect(cornerPosition("top-left", 300, 200, viewport)).toEqual({
      x: EDGE_MARGIN,
      y: EDGE_MARGIN,
    });
    expect(cornerPosition("bottom-right", 300, 200, viewport)).toEqual({
      x: 1000 - 300 - EDGE_MARGIN,
      y: 800 - 200 - BOTTOM_MARGIN,
    });
    // A tiny viewport never pushes it off screen.
    expect(cornerPosition("bottom-right", 300, 200, { width: 200, height: 150 })).toEqual({
      x: EDGE_MARGIN,
      y: EDGE_MARGIN,
    });
  });

  it("keeps a dragged window on screen", () => {
    expect(clampToViewport(-50, 900, 300, 200, viewport)).toEqual({ x: 0, y: 600 });
  });

  it("moves one corner over with the arrow keys", () => {
    expect(cornerAfterKey("bottom-right", "ArrowUp")).toBe("top-right");
    expect(cornerAfterKey("bottom-right", "ArrowLeft")).toBe("bottom-left");
    expect(cornerAfterKey("top-left", "ArrowDown")).toBe("bottom-left");
    expect(cornerAfterKey("top-left", "Enter")).toBeNull();
  });
});
