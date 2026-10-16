/**
 * Zoom and pan math for the image lightbox. The image is centered in its
 * viewport and drawn with `translate(x, y) scale(scale)` around its center;
 * points are relative to the viewport's center.
 */
export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
/** Double-click / double-tap zoom. */
export const DOUBLE_TAP_ZOOM = 2.5;

export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };

export interface Point {
  x: number;
  y: number;
}

/** The viewport's center (points are relative to it). */
const CENTER: Point = { x: 0, y: 0 };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Keeps the image covering the viewport where it can: at a given scale it may
 * move at most until its edge reaches the viewport's edge (no further, so it
 * can't be lost off screen).
 */
export function clampPan(
  view: ZoomView,
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): ZoomView {
  const maxX = Math.max(0, (image.width * view.scale - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * view.scale - viewport.height) / 2);
  return { scale: view.scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

/**
 * Zooms to `scale` keeping the image point under `at` where it is (the cursor,
 * the pinch center, the tapped spot). Back at 1× the image is re-centered.
 */
export function zoomTo(view: ZoomView, scale: number, at: Point = CENTER): ZoomView {
  const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  if (next === MIN_ZOOM) return FIT;
  const ratio = next / view.scale;
  return { scale: next, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

/** Double-click / double-tap: zoom in on `at`, or back to fit when zoomed. */
export function toggleZoom(view: ZoomView, at: Point): ZoomView {
  return view.scale > MIN_ZOOM ? FIT : zoomTo(view, DOUBLE_TAP_ZOOM, at);
}

/** Mouse wheel / trackpad pinch (`deltaY`, in pixels) as a smooth zoom factor. */
export const wheelFactor = (deltaY: number) => Math.exp(-deltaY / 300);
