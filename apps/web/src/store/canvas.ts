import type { Canvas, CanvasUpdatedEvent } from "@mindfultech/shared";
import { create } from "zustand";
import { canvasApi, CanvasConflictError, type CanvasApi } from "../lib/canvasApi";

/**
 * Channel canvases (Phase 24): the document of each conversation the person
 * has opened, its save state, and which conversations show their canvas
 * beside the chat (remembered on this device). Saves are whole and
 * last-writer-wins: a save based on an older version is refused by the
 * server, and the store takes the current one so the editor can reload it.
 */
export type SaveState = "idle" | "loading" | "saving" | "saved" | "conflict" | "error";

export interface CanvasState {
  canvases: Record<string, Canvas>;
  status: Record<string, SaveState>;
  /** Conversations whose canvas is open beside the chat. */
  open: Record<string, boolean>;
  error: string | null;

  /** Fetches the canvas once (again with `force`, e.g. after a `canvas.updated`). */
  load: (channelId: string, force?: boolean) => Promise<void>;
  /**
   * Saves `content` as the next version. Resolves `"saved"`, `"conflict"`
   * (someone saved meanwhile: the store now holds their version, the editor
   * should reload it) or `"error"` (kept locally; try again).
   */
  save: (channelId: string, content: string) => Promise<"saved" | "conflict" | "error">;
  /** A `canvas.updated` push: someone else's save means our copy is stale. */
  applyEvent: (push: CanvasUpdatedEvent, myUserId: string) => void;
  setOpen: (channelId: string, open: boolean) => void;
  clearError: () => void;
  /** Forgets everything but which canvases are open (sign-out). */
  reset: () => void;
}

const OPEN_KEY = "slack.canvas.open";

function loadOpen(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(([, v]) => v === true),
      ) as Record<string, boolean>;
    }
  } catch {
    // Not remembered: every canvas starts closed.
  }
  return {};
}

function saveOpen(open: Record<string, boolean>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open));
  } catch {
    // Not persisted; the layout still works for this session.
  }
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function createCanvasStore(api: CanvasApi) {
  return create<CanvasState>((set, get) => ({
    canvases: {},
    status: {},
    open: loadOpen(),
    error: null,

    load: async (channelId, force = false) => {
      if (!force && channelId in get().canvases) return;
      set((s) => ({ status: { ...s.status, [channelId]: "loading" } }));
      try {
        const canvas = await api.get(channelId);
        set((s) => ({
          canvases: { ...s.canvases, [channelId]: canvas },
          status: { ...s.status, [channelId]: "idle" },
        }));
      } catch (err) {
        set((s) => ({
          status: { ...s.status, [channelId]: "error" },
          error: message(err, "Couldn't load the canvas."),
        }));
      }
    },

    save: async (channelId, content) => {
      const version = get().canvases[channelId]?.version ?? 0;
      set((s) => ({ status: { ...s.status, [channelId]: "saving" } }));
      try {
        const canvas = await api.save(channelId, { content, version });
        set((s) => ({
          canvases: { ...s.canvases, [channelId]: canvas },
          status: { ...s.status, [channelId]: "saved" },
        }));
        return "saved";
      } catch (err) {
        if (err instanceof CanvasConflictError) {
          set((s) => ({
            canvases: { ...s.canvases, [channelId]: err.current },
            status: { ...s.status, [channelId]: "conflict" },
          }));
          return "conflict";
        }
        set((s) => ({
          status: { ...s.status, [channelId]: "error" },
          error: message(err, "Couldn't save the canvas."),
        }));
        return "error";
      }
    },

    applyEvent: (push, myUserId) => {
      const { channelId } = push;
      const mine = get().canvases[channelId];
      // Our own save already put the new version in the store; an unknown canvas needs no fetch.
      if (!mine || push.updatedBy === myUserId || push.version <= mine.version) return;
      void get().load(channelId, true);
    },

    setOpen: (channelId, open) => {
      const next = { ...get().open };
      if (open) next[channelId] = true;
      else delete next[channelId];
      saveOpen(next);
      set({ open: next });
    },

    clearError: () => set({ error: null }),

    reset: () => set({ canvases: {}, status: {}, error: null }),
  }));
}

export const useCanvas = createCanvasStore(canvasApi);
