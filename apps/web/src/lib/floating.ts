/**
 * Geometry of the floating call window: it can be dragged anywhere and snaps
 * to the nearest corner of the viewport on release (like Google Meet's
 * picture-in-picture). The corner is remembered on this device.
 */
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Gap to the viewport's sides and top. */
export const EDGE_MARGIN = 16;
/** Gap to the bottom: clears the message composer. */
export const BOTTOM_MARGIN = 96;

const STORAGE_KEY = "slack.callCorner";

export function loadCorner(): Corner {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return CORNERS.includes(saved as Corner) ? (saved as Corner) : "bottom-right";
  } catch {
    return "bottom-right";
  }
}

export function saveCorner(corner: Corner): void {
  try {
    localStorage.setItem(STORAGE_KEY, corner);
  } catch {
    // Not persisted: the window still snaps for this session.
  }
}

/** The corner nearest to the window's center at (`x`, `y`) in a `width`×`height` viewport. */
export function nearestCorner(x: number, y: number, width: number, height: number): Corner {
  const vertical = y < height / 2 ? "top" : "bottom";
  const horizontal = x < width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

/** Top-left position of a `w`×`h` window parked in `corner` of the viewport. */
export function cornerPosition(
  corner: Corner,
  w: number,
  h: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const x = corner.endsWith("left") ? EDGE_MARGIN : viewport.width - w - EDGE_MARGIN;
  const y = corner.startsWith("top") ? EDGE_MARGIN : viewport.height - h - BOTTOM_MARGIN;
  return { x: Math.max(EDGE_MARGIN, x), y: Math.max(EDGE_MARGIN, y) };
}

/** Keeps a dragged window fully on screen. */
export function clampToViewport(
  x: number,
  y: number,
  w: number,
  h: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, viewport.width - w)),
    y: Math.min(Math.max(0, y), Math.max(0, viewport.height - h)),
  };
}

/** Arrow keys move the window one corner over (keyboard alternative to dragging). */
export function cornerAfterKey(corner: Corner, key: string): Corner | null {
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  switch (key) {
    case "ArrowUp":
      return `top-${h}`;
    case "ArrowDown":
      return `bottom-${h}`;
    case "ArrowLeft":
      return `${v}-left`;
    case "ArrowRight":
      return `${v}-right`;
    default:
      return null;
  }
}
