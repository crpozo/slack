import { useCallback, useRef, useState, type RefObject } from "react";
import {
  clampSplit,
  loadSplit,
  saveSplit,
  SPLIT_DEFAULTS,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
  splitAt,
  type PaneKind,
} from "../lib/split";

/** The right pane's width (percent of the row) for `kind`, and how to change it. */
export function usePaneSplit(kind: PaneKind) {
  const [percent, setPercent] = useState(() => loadSplit(kind));
  const set = useCallback((value: number) => setPercent(clampSplit(value)), []);
  const commit = useCallback((value: number) => saveSplit(kind, value), [kind]);
  return {
    percent,
    set,
    commit,
    reset: () => (set(SPLIT_DEFAULTS[kind]), commit(SPLIT_DEFAULTS[kind])),
  };
}

/**
 * The divider between the conversation and the right-hand pane (desktop).
 * Drag it (mouse, pen or touch) or focus it and use the arrows; double-click
 * puts it back. The pane stays between 30% and 70% of the row.
 */
export function PaneResizer({
  rowRef,
  percent,
  onChange,
  onCommit,
  onReset,
  label,
}: Readonly<{
  rowRef: RefObject<HTMLElement | null>;
  percent: number;
  onChange: (percent: number) => void;
  onCommit: (percent: number) => void;
  onReset: () => void;
  label: string;
}>) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(percent);
  latest.current = percent;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const row = rowRef.current?.getBoundingClientRect();
    if (row) onChange(splitAt(e.clientX, row));
  }
  function end() {
    if (!dragging) return;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onCommit(latest.current);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // The divider moves: left widens the pane, right narrows it.
    const steps: Record<string, number> = {
      ArrowLeft: SPLIT_STEP,
      ArrowRight: -SPLIT_STEP,
      PageUp: SPLIT_STEP * 5,
      PageDown: -SPLIT_STEP * 5,
    };
    let next: number | null = null;
    if (e.key in steps) next = clampSplit(percent + steps[e.key]!);
    else if (e.key === "Home") next = SPLIT_MAX;
    else if (e.key === "End") next = SPLIT_MIN;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
    onCommit(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      aria-valuenow={Math.round(percent)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
      data-pane-resizer
    >
      <span
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
          dragging
            ? "w-0.5 bg-primary"
            : "bg-line group-hover:w-0.5 group-hover:bg-primary/70 group-focus-visible:w-0.5 group-focus-visible:bg-primary"
        }`}
        aria-hidden="true"
      />
    </div>
  );
}
