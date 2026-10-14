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

interface MessageGestureOptions {
  onLongPress: () => void;
  onSwipeRight: () => void;
  /** Off while the message is pending/failed. */
  enabled: boolean;
}

/**
 * Touch gestures of a message row (mouse and pen are untouched: desktop keeps
 * hover and clicks). Long press → `onLongPress`; swipe right → `onSwipeRight`.
 * The row needs `touch-action: pan-y` so vertical scrolling stays native.
 */
export function useMessageGestures({ onLongPress, onSwipeRight, enabled }: MessageGestureOptions) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const axis = useRef<DragAxis>("pending");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A long press just fired: swallow the click that follows the release. */
  const suppressClick = useRef(false);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const reset = useCallback(() => {
    clearTimer();
    start.current = null;
    axis.current = "pending";
    setOffset(0);
  }, []);
  useEffect(() => clearTimer, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!enabled || e.pointerType !== "touch" || e.clientX <= EDGE_PX) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis.current = "pending";
    suppressClick.current = false;
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
    }
    if (axis.current === "horizontal") setOffset(swipeOffset(dx));
  };

  const onPointerUp = () => {
    if (axis.current === "horizontal" && offset >= SWIPE_TRIGGER_PX) {
      buzz(10);
      onSwipeRight();
    }
    reset();
  };

  return {
    offset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: reset,
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
    let startX = 0;
    let startY = 0;
    let id = -1;
    let axis: DragAxis = "pending";
    let current: number | null = null;
    const update = (p: number | null) => {
      current = p;
      setProgress(p);
    };

    const down = (e: globalThis.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (!open && e.clientX > EDGE_PX) return;
      startX = e.clientX;
      startY = e.clientY;
      id = e.pointerId;
      axis = "pending";
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - startX;
      if (axis === "pending") axis = classifyDrag(dx, e.clientY - startY);
      if (axis !== "horizontal") return;
      const base = open ? 1 : 0;
      update(Math.min(1, Math.max(0, base + dx / width)));
    };
    const up = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      if (axis === "horizontal" && current !== null) {
        if (open && current < 0.65) onClose();
        else if (!open && current > 0.35) onOpen();
      }
      update(null);
    };
    const opts = { passive: true } as const;
    document.addEventListener("pointerdown", down, opts);
    document.addEventListener("pointermove", move, opts);
    document.addEventListener("pointerup", up, opts);
    document.addEventListener("pointercancel", up, opts);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, [enabled, open, width, onOpen, onClose]);
  return progress;
}
