import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/** Below this travel (px) a touch is still a tap / long press. */
export const SLOP_PX = 10;
/** Hold this long without moving to long-press. */
export const LONG_PRESS_MS = 400;
/** Swipe a message this far right to reply… */
export const SWIPE_TRIGGER_PX = 60;
/** …and it never follows the finger further than this. */
export const SWIPE_MAX_PX = 80;
/** Touches starting this close to the left edge belong to the sidebar, not to messages. */
export const EDGE_PX = 24;

export type DragAxis = "pending" | "horizontal" | "vertical";

/**
 * Which way a touch is going: undecided until it travels `SLOP_PX`, then
 * whichever axis dominates. Vertical drags are left to the browser (scroll).
 */
export function classifyDrag(dx: number, dy: number): DragAxis {
  if (Math.hypot(dx, dy) < SLOP_PX) return "pending";
  return Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
}

/** How far a message row follows a rightward swipe (0 for leftward), with resistance past the trigger. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_TRIGGER_PX) return dx;
  return Math.min(SWIPE_MAX_PX, SWIPE_TRIGGER_PX + (dx - SWIPE_TRIGGER_PX) / 3);
}

const buzz = (ms: number) => navigator.vibrate?.(ms);

/** A click arriving this long after a touch gesture ended still belongs to it. */
export const CLICK_GUARD_MS = 500;

/**
 * Swallows every `click` on the page for `CLICK_GUARD_MS` after a touch drag.
 * Some browsers still synthesize a click at the lift point, and it would land
 * on whatever just moved under the finger (e.g. `#general`, the first row of
 * the drawer that just slid open). Capture phase on `document`, so no handler
 * (React's included) ever sees it. A backstop: the gestures below also cancel
 * the `touchend` itself, which stops the browser from making the click at all.
 */
export function swallowNextClick(): void {
  const guard = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("click", guard, { capture: true });
  setTimeout(() => document.removeEventListener("click", guard, { capture: true }), CLICK_GUARD_MS);
}

/** Interactive elements keep their taps even inside the edge strip (e.g. the ☰ button). */
const isInteractive = (target: EventTarget | null) =>
  typeof (target as Element | null)?.closest === "function" &&
  !!(target as Element).closest("button, a, input, textarea, select, [role=button]");

interface MessageGestureOptions {
  onLongPress: () => void;
  onSwipeRight: () => void;
  /** Off while the message is pending/failed. */
  enabled: boolean;
}

/**
 * Touch gestures of a message row (mouse and pen are untouched: desktop keeps
 * hover and clicks). Long press → `onLongPress`; swipe right → `onSwipeRight`.
 *
 * The row needs `touch-action: pan-y` (vertical scrolling stays native) and its
 * list `overflow-x: hidden` (a row sliding right must not give the list a
 * horizontal scrollbar to scroll instead). `ref` attaches native `touchmove` /
 * `touchend` listeners — React's are passive and can't cancel anything — so
 * that once a swipe is horizontal, nothing else moves: no vertical scroll on a
 * tall message, no browser back/forward swipe, no click at the lift point.
 * The pointer is captured, so a short row keeps the drag when the finger drifts.
 * `touchY` is where the finger is in the row: the reply arrow is drawn there,
 * so it stays in view on messages taller than the screen.
 */
export function useMessageGestures({ onLongPress, onSwipeRight, enabled }: MessageGestureOptions) {
  const [offset, setOffset] = useState(0);
  const [touchY, setTouchY] = useState(0);
  const offsetRef = useRef(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const axis = useRef<DragAxis>("pending");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A long press just fired: swallow the click that follows the release. */
  const suppressClick = useRef(false);
  /** The current touch became a horizontal swipe (read by the native touch listeners). */
  const swiping = useRef(false);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (px: number) => {
    offsetRef.current = px;
    setOffset(px);
  };
  const reset = useCallback(() => {
    clearTimer();
    start.current = null;
    axis.current = "pending";
    offsetRef.current = 0;
    setOffset(0);
  }, []);
  useEffect(() => clearTimer, []);

  // Native, non-passive: only these can stop the browser mid-gesture.
  const cleanup = useRef<(() => void) | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (swiping.current && e.cancelable) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!swiping.current) return;
      swiping.current = false;
      if (e.cancelable) e.preventDefault(); // no synthesized click at the lift point
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd);
    cleanup.current = () => {
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!enabled || e.pointerType !== "touch" || e.clientX <= EDGE_PX) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis.current = "pending";
    swiping.current = false;
    suppressClick.current = false;
    setTouchY(e.clientY - e.currentTarget.getBoundingClientRect().top);
    // Keep the drag even if the finger leaves a short row.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    clearTimer();
    timer.current = setTimeout(() => {
      if (axis.current !== "pending") return;
      suppressClick.current = true;
      start.current = null;
      buzz(15);
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (axis.current === "pending") {
      axis.current = classifyDrag(dx, dy);
      if (axis.current !== "pending") clearTimer();
      if (axis.current === "vertical") return reset();
      if (axis.current === "horizontal") swiping.current = true;
    }
    // Only the horizontal distance counts, however tall the row or wobbly the finger.
    if (axis.current === "horizontal") show(swipeOffset(dx));
  };

  const onPointerUp = () => {
    if (axis.current === "horizontal") {
      swallowNextClick();
      if (offsetRef.current >= SWIPE_TRIGGER_PX) {
        buzz(10);
        onSwipeRight();
      }
    }
    reset();
  };

  return {
    offset,
    touchY,
    ref,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: () => {
        swiping.current = false;
        reset();
      },
      onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      // Android Chrome opens a context menu on long press: ours replaces it.
      onContextMenu: (e: { preventDefault: () => void }) => {
        if (suppressClick.current) e.preventDefault();
      },
    },
  };
}

interface EdgeSwipeOptions {
  open: boolean;
  /** Drawer width in px. */
  width: number;
  onOpen: () => void;
  onClose: () => void;
  /** 0…1 while dragging, `null` when the finger lifts. */
  onProgress: (progress: number | null) => void;
}

/**
 * Wires the drawer's edge swipe on `target` (the document): pointer events
 * drive the drawer, native non-passive touch listeners stop the browser from
 * acting on the same touch. Returns the cleanup.
 */
export function attachEdgeSwipe(
  target: EventTarget,
  { open, width, onOpen, onClose, onProgress }: EdgeSwipeOptions,
): () => void {
  let startX = 0;
  let startY = 0;
  let id = -1;
  let axis: DragAxis = "pending";
  let current: number | null = null;
  /** This touch dragged the drawer: its touchend must not become a click. */
  let dragged = false;
  const update = (p: number | null) => {
    current = p;
    onProgress(p);
  };

  const down = (e: Event) => {
    const p = e as globalThis.PointerEvent;
    if (p.pointerType !== "touch") return;
    if (!open && p.clientX > EDGE_PX) return;
    startX = p.clientX;
    startY = p.clientY;
    id = p.pointerId;
    axis = "pending";
    dragged = false;
  };
  const move = (e: Event) => {
    const p = e as globalThis.PointerEvent;
    if (p.pointerId !== id) return;
    const dx = p.clientX - startX;
    if (axis === "pending") axis = classifyDrag(dx, p.clientY - startY);
    if (axis !== "horizontal") return;
    dragged = true;
    const base = open ? 1 : 0;
    update(Math.min(1, Math.max(0, base + dx / width)));
  };
  const up = (e: Event) => {
    if ((e as globalThis.PointerEvent).pointerId !== id) return;
    id = -1;
    if (axis === "horizontal") {
      // Backstop for browsers that synthesize the click anyway.
      swallowNextClick();
      if (current !== null) {
        if (open && current < 0.65) onClose();
        else if (!open && current > 0.35) onOpen();
      }
    }
    axis = "pending";
    update(null);
  };

  const touchStart = (e: Event) => {
    const t = (e as TouchEvent).touches[0];
    // iOS Safari: a swipe in from the left edge is its *history back* gesture.
    // Our drawer would open, then the page would go back (often to #general).
    // Cancelling touchstart in the edge strip keeps the gesture ours; pointer
    // events still fire, and buttons there keep their taps.
    if (!open && t && t.clientX <= EDGE_PX && !isInteractive(e.target) && e.cancelable) {
      e.preventDefault();
    }
  };
  const touchMove = (e: Event) => {
    // No scrolling or overscroll while the drawer follows the finger.
    if (axis === "horizontal" && e.cancelable) e.preventDefault();
  };
  const touchEnd = (e: Event) => {
    if (!dragged) return;
    dragged = false;
    // Cancelling touchend stops the browser from synthesizing the click that
    // would land on the drawer row now under the finger (the `#general` ghost click).
    if (e.cancelable) e.preventDefault();
  };

  const passive = { passive: true } as const;
  const active = { passive: false } as const;
  const listeners: Array<[string, (e: Event) => void, AddEventListenerOptions]> = [
    ["pointerdown", down, passive],
    ["pointermove", move, passive],
    ["pointerup", up, passive],
    ["pointercancel", up, passive],
    ["touchstart", touchStart, active],
    ["touchmove", touchMove, active],
    ["touchend", touchEnd, active],
  ];
  for (const [type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
  return () => {
    for (const [type, fn] of listeners) target.removeEventListener(type, fn);
  };
}

/**
 * Edge swipe for the mobile drawer: a touch starting within `EDGE_PX` of the
 * left edge drags the sidebar open (it follows the finger); a leftward drag
 * while open closes it. `progress` is 0…1 while dragging, `null` otherwise.
 */
export function useEdgeSwipe({
  enabled,
  open,
  width,
  onOpen,
  onClose,
}: {
  enabled: boolean;
  open: boolean;
  /** Drawer width in px. */
  width: number;
  onOpen: () => void;
  onClose: () => void;
}): number | null {
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    return attachEdgeSwipe(document, { open, width, onOpen, onClose, onProgress: setProgress });
  }, [enabled, open, width, onOpen, onClose]);
  return progress;
}
