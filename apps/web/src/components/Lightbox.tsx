import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampPan, FIT, toggleZoom, wheelFactor, zoomTo, type ZoomView } from "../lib/zoom";
import { CloseIcon, DownloadIcon } from "./icons";
import { useModalDialog } from "./Modal";

/** Two taps this close (ms, px) are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
/** A press that moves less than this is a tap, not a drag. */
const TAP_SLOP_PX = 6;
const STEP = 1.5;

interface LightboxProps {
  /** The original, full-size image. */
  src: string;
  /** The thumbnail already on screen, shown until the original has loaded. */
  placeholder?: string;
  name: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer: the picture fits the screen; wheel / pinch zoom
 * toward the cursor or fingers, double-click / double-tap toggles 2.5×, drag
 * pans while zoomed. Esc, ✕, or a tap beside the picture closes it.
 *
 * Gestures use native listeners, and the dialog stops pointer and touch
 * events from bubbling out: the page's own gestures (swipe to reply, the
 * drawer's edge swipe, listening on `document`) never see them.
 */
export function Lightbox({ src, placeholder, name, onClose }: Readonly<LightboxProps>) {
  const dialog = useModalDialog(onClose);
  const [loaded, setLoaded] = useState(!placeholder);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<ZoomView>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const root = dialog.current;
    const viewport = viewportRef.current;
    if (!root || !viewport) return;

    /** Point relative to the viewport's center. */
    const at = (clientX: number, clientY: number) => {
      const r = viewport.getBoundingClientRect();
      return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
    };
    const apply = (next: ZoomView) => {
      const img = imageRef.current;
      const r = viewport.getBoundingClientRect();
      // offsetWidth/Height: the fitted size, before the transform.
      const bounded = img
        ? clampPan(next, { width: img.offsetWidth, height: img.offsetHeight }, r)
        : next;
      viewRef.current = bounded;
      setView(bounded);
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let start: { view: ZoomView; a: { x: number; y: number }; dist: number } | null = null;
    let moved = false;
    /** The press started beside the picture (pointerup is retargeted by the capture). */
    let onBackdrop = false;
    let lastTap: { t: number; x: number; y: number } | null = null;
    /** A tap beside the picture closes after a beat, unless it becomes a double tap. */
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const begin = () => {
      const [p, q] = [...pointers.values()];
      if (!p) {
        start = null;
        return;
      }
      const a = q ? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } : p;
      const dist = q ? Math.hypot(p.x - q.x, p.y - q.y) : 0;
      start = { view: viewRef.current, a, dist };
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      viewport.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, at(e.clientX, e.clientY));
      if (pointers.size === 1) {
        moved = false;
        onBackdrop = e.target === viewport;
      }
      begin();
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId) || !start) return;
      pointers.set(e.pointerId, at(e.clientX, e.clientY));
      const [p, q] = [...pointers.values()];
      if (!p) return;
      if (q && start.dist > 0) {
        // Pinch: scale by the fingers' spread, around where they started; follow their midpoint.
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        const scale = start.view.scale * (Math.hypot(p.x - q.x, p.y - q.y) / start.dist);
        const zoomed = zoomTo(start.view, scale, start.a);
        moved = true;
        apply({ ...zoomed, x: zoomed.x + mid.x - start.a.x, y: zoomed.y + mid.y - start.a.y });
        return;
      }
      const dx = p.x - start.a.x;
      const dy = p.y - start.a.y;
      if (Math.hypot(dx, dy) > TAP_SLOP_PX) moved = true;
      if (moved && start.view.scale > 1) {
        apply({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
      }
    };
    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const point = pointers.get(e.pointerId)!;
      pointers.delete(e.pointerId);
      begin(); // a finger left a pinch: keep panning with the other
      if (pointers.size > 0 || moved || e.type === "pointercancel") return;
      // A tap. Touch: two in a row toggle zoom (mice get `dblclick`).
      if (e.pointerType !== "mouse") {
        const now = performance.now();
        if (
          lastTap &&
          now - lastTap.t < DOUBLE_TAP_MS &&
          Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < DOUBLE_TAP_PX
        ) {
          lastTap = null;
          clearTimeout(closeTimer);
          apply(toggleZoom(viewRef.current, point));
          return;
        }
        lastTap = { t: now, ...point };
      }
      // Beside the picture, not zoomed: close.
      if (onBackdrop && viewRef.current.scale === 1) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => closeRef.current(), DOUBLE_TAP_MS);
      }
    };
    const dblclick = (e: MouseEvent) => {
      clearTimeout(closeTimer);
      apply(toggleZoom(viewRef.current, at(e.clientX, e.clientY)));
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); // no page zoom (ctrl + wheel / trackpad pinch) or scroll
      const v = viewRef.current;
      apply(zoomTo(v, v.scale * wheelFactor(e.deltaY), at(e.clientX, e.clientY)));
    };
    const key = (e: KeyboardEvent) => {
      const v = viewRef.current;
      if (e.key === "+" || e.key === "=") apply(zoomTo(v, v.scale * STEP));
      else if (e.key === "-") apply(zoomTo(v, v.scale / STEP));
      else if (e.key === "0") apply(FIT);
    };
    const stop = (e: Event) => e.stopPropagation();

    const listeners: Array<[EventTarget, string, (e: never) => void, AddEventListenerOptions?]> = [
      [viewport, "pointerdown", down],
      [viewport, "pointermove", move],
      [viewport, "pointerup", up],
      [viewport, "pointercancel", up],
      [viewport, "dblclick", dblclick],
      [viewport, "wheel", wheel, { passive: false }],
      [root, "keydown", key],
      // Keep the page's gestures out of it (see above). Clicks still reach React.
      ...(
        [
          "pointerdown",
          "pointermove",
          "pointerup",
          "pointercancel",
          "touchstart",
          "touchmove",
          "touchend",
        ] as const
      ).map((type) => [root, type, stop] as [EventTarget, string, (e: never) => void]),
    ];
    for (const [target, type, fn, opts] of listeners) {
      target.addEventListener(type, fn as EventListener, opts);
    }
    return () => {
      clearTimeout(closeTimer);
      for (const [target, type, fn] of listeners) {
        target.removeEventListener(type, fn as EventListener);
      }
    };
  }, [dialog]);

  const zoomBy = (factor: number) => setView((v) => zoomTo(v, v.scale * factor));
  const button =
    "flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-40";

  return createPortal(
    <dialog
      ref={dialog}
      aria-label={name}
      className="m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-black/90 p-0 text-white backdrop:bg-black/80"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <p className="mr-auto min-w-0 truncate text-sm font-medium" title={name}>
            {name}
          </p>
          <button
            type="button"
            className={button}
            onClick={() => zoomBy(1 / STEP)}
            disabled={view.scale <= 1}
            aria-label="Zoom out"
            title="Zoom out (−)"
          >
            −
          </button>
          <button
            type="button"
            className={`${button} w-14 text-xs tabular-nums`}
            onClick={() => setView(FIT)}
            aria-label="Fit to screen"
            title="Fit to screen (0)"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            type="button"
            className={button}
            onClick={() => zoomBy(STEP)}
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            +
          </button>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            download={name}
            className={button}
            aria-label={`Download ${name}`}
            title="Download"
          >
            <DownloadIcon />
          </a>
          <button
            type="button"
            className={button}
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </header>
        <div
          ref={viewportRef}
          className={`relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-6 ${
            view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
          }`}
        >
          <img
            ref={imageRef}
            src={loaded ? src : placeholder}
            alt={name}
            draggable={false}
            className="max-h-full max-w-full object-contain will-change-transform"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          />
          {!loaded && (
            // Decodes the original off screen; the placeholder is swapped out once it's ready.
            <img
              src={src}
              alt=""
              aria-hidden="true"
              className="hidden"
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(true)}
            />
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
