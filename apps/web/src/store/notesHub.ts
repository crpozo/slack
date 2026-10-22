import type { AiNotes, Message } from "@mindfultech/shared";
import { create } from "zustand";
import { notesApi, type NotesApi } from "../lib/notesApi";

/**
 * The AI Notes hub (Phase 29): every notes card of the conversations you're
 * in, newest first, a page at a time (`GET /notes`). New cards and their
 * updates arrive over the socket like any message (`message.new`,
 * `message.updated`) and are applied here too, so the feed stays live.
 */
export interface NotesHubState {
  notes: Message[];
  nextCursor: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  /** The first page (again, on a retry). */
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** A notes card posted while the hub is loaded. */
  upsert: (message: Message) => void;
  /** A card moved on (ready, failed, sent to a board). */
  update: (channelId: string, sk: string, aiNotes: AiNotes, text: string) => void;
  reset: () => void;
}

const failure = (err: unknown) =>
  err instanceof Error && err.message ? err.message : "Couldn't load the notes.";

/** Newest first: message sort keys are `<epoch ms>#<ulid>`, so they order as strings. */
const newestFirst = (a: Message, b: Message) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0);

const same = (m: Message, channelId: string, sk: string) =>
  m.channelId === channelId && m.sk === sk;

export function createNotesHub(api: Pick<NotesApi, "list"> = notesApi) {
  const initial = {
    notes: [] as Message[],
    nextCursor: null as string | null,
    status: "idle" as const,
    loadingMore: false,
    error: null as string | null,
  };
  // A reset while a request is out makes its answer stale.
  let generation = 0;
  return create<NotesHubState>()((set, get) => ({
    ...initial,

    async load() {
      const mine = ++generation;
      set({ status: "loading", error: null });
      try {
        const page = await api.list(null);
        if (mine !== generation) return;
        set({ notes: page.notes, nextCursor: page.nextCursor, status: "ready" });
      } catch (err) {
        if (mine === generation) set({ status: "error", error: failure(err) });
      }
    },

    async loadMore() {
      const { nextCursor, loadingMore, status } = get();
      if (!nextCursor || loadingMore || status !== "ready") return;
      const mine = generation;
      set({ loadingMore: true, error: null });
      try {
        const page = await api.list(nextCursor);
        if (mine !== generation) return;
        set((s) => {
          const seen = new Set(s.notes.map((m) => `${m.channelId}|${m.sk}`));
          const fresh = page.notes.filter((m) => !seen.has(`${m.channelId}|${m.sk}`));
          return { notes: [...s.notes, ...fresh], nextCursor: page.nextCursor, loadingMore: false };
        });
      } catch (err) {
        if (mine === generation) set({ loadingMore: false, error: failure(err) });
      }
    },

    upsert(message) {
      if (message.kind !== "ai_notes" || get().status !== "ready") return;
      set((s) => {
        const others = s.notes.filter((m) => !same(m, message.channelId, message.sk));
        return { notes: [...others, message].sort(newestFirst) };
      });
    },

    update(channelId, sk, aiNotes, text) {
      if (!get().notes.some((m) => same(m, channelId, sk))) return;
      set((s) => ({
        notes: s.notes.map((m) => (same(m, channelId, sk) ? { ...m, aiNotes, text } : m)),
      }));
    },

    reset() {
      generation++;
      set(initial);
    },
  }));
}

export const useNotesHub = createNotesHub();
