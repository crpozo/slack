// ---------------------------------------------------------------------------
// The resizable right-hand pane (Phase 25): its width as a share of the
// conversation's row, between `SPLIT_MIN` and `SPLIT_MAX`, remembered per kind
// of pane (a thread is usually narrower than a board) on this device.
// ---------------------------------------------------------------------------

export const SPLIT_MIN = 30;
export const SPLIT_MAX = 70;
/** Keyboard step (arrows); PageUp/PageDown move five times as far. */
export const SPLIT_STEP = 2;

export type PaneKind = "thread" | "board";
export const SPLIT_DEFAULTS: Record<PaneKind, number> = { thread: 35, board: 50 };

const key = (kind: PaneKind) => `slack.split.${kind}`;

export function clampSplit(percent: number): number {
  if (!Number.isFinite(percent)) return 50;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, percent)) * 10) / 10;
}

/** The pane's share when the divider is at `clientX` in a row spanning `left`..`left + width`. */
export function splitAt(clientX: number, row: { left: number; width: number }): number {
  if (row.width <= 0) return 50;
  return clampSplit(((row.left + row.width - clientX) / row.width) * 100);
}

export function loadSplit(kind: PaneKind): number {
  try {
    const raw = localStorage.getItem(key(kind));
    if (raw !== null) {
      const value = Number(raw);
      if (Number.isFinite(value)) return clampSplit(value);
    }
  } catch {
    // Not remembered: the default.
  }
  return SPLIT_DEFAULTS[kind];
}

export function saveSplit(kind: PaneKind, percent: number): void {
  try {
    localStorage.setItem(key(kind), String(clampSplit(percent)));
  } catch {
    // Not persisted; the layout still works for this session.
  }
}
