import { create } from "zustand";

/**
 * Which project channels show their board beside the chat (Phase 24), on
 * this device. Desktop only: phones open the Task Manager instead.
 */
export interface BoardPaneState {
  open: Record<string, boolean>;
  setOpen: (channelId: string, open: boolean) => void;
}

const STORAGE_KEY = "slack.boardPane.open";

function load(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(([, v]) => v === true),
      ) as Record<string, boolean>;
    }
  } catch {
    // Not remembered: every board pane starts closed.
  }
  return {};
}

function save(open: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // Not persisted; the layout still works for this session.
  }
}

export function createBoardPaneStore() {
  return create<BoardPaneState>((set, get) => ({
    open: load(),
    setOpen: (channelId, open) => {
      const next = { ...get().open };
      if (open) next[channelId] = true;
      else delete next[channelId];
      save(next);
      set({ open: next });
    },
  }));
}

export const useBoardPane = createBoardPaneStore();
