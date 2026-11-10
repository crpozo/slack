import { create } from "zustand";

/**
 * Hours (Phase 60): which channel's time log is open, and a counter per
 * channel that the server's `time.updated` bumps, so an open log reads again.
 */
interface TimeLogUi {
  openFor: string | null;
  version: Record<string, number>;
  open: (channelId: string) => void;
  close: () => void;
  changed: (channelId: string) => void;
}

export const useTimeLog = create<TimeLogUi>((set) => ({
  openFor: null,
  version: {},
  open: (channelId) => set({ openFor: channelId }),
  close: () => set({ openFor: null }),
  changed: (channelId) =>
    set((s) => ({ version: { ...s.version, [channelId]: (s.version[channelId] ?? 0) + 1 } })),
}));
