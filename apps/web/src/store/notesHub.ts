import {
  foldMeetingTopic,
  type AiNotes,
  type MeetingTopicCount,
  type Message,
} from "@mindfultech/shared";
import { create } from "zustand";
import { notesApi, type NotesApi } from "../lib/notesApi";

/**
 * The AI Notes hub (Phase 29): every notes card of the conversations you're
 * in, newest first, a page at a time (`GET /notes`). New cards and their
 * updates arrive over the socket like any message (`message.new`,
 * `message.updated`) and are applied here too, so the feed stays live.
 *
 * Phase 50: `topic` narrows the feed to one meeting topic, asked of the
 * server (its own index), so a topic's notes are all there, not only the ones
 * loaded so far; `topics` lists yours with their counts.
 */
export interface NotesHubState {
  notes: Message[];
  nextCursor: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  /** The meeting topic shown (`null`: every note). */
  topic: string | null;
  topics: MeetingTopicCount[];
  /** The first page (again, on a retry). */
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Shows one meeting topic's notes (or all of them with `null`). */
  showTopic: (topic: string | null) => Promise<void>;
  loadTopics: () => Promise<void>;
  /** A notes card posted while the hub is loaded. */
  upsert: (message: Message) => void;
  /** A card moved on (ready, failed, sent to a board, filed under a topic). */
  update: (channelId: string, sk: string, aiNotes: AiNotes, text: string) => void;
  /** A card was deleted (Phase 32). */
  remove: (channelId: string, sk: string) => void;
  reset: () => void;
}

const failure = (err: unknown) =>
  err instanceof Error && err.message ? err.message : "Couldn't load the notes.";

/** Newest first: message sort keys are `<epoch ms>#<ulid>`, so they order as strings. */
const newestFirst = (a: Message, b: Message) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0);

const same = (m: Message, channelId: string, sk: string) =>
  m.channelId === channelId && m.sk === sk;

const inTopic = (message: Message, topic: string | null) =>
  !topic || foldMeetingTopic(message.aiNotes?.topic ?? "") === foldMeetingTopic(topic);

export function createNotesHub(api: Pick<NotesApi, "list" | "topics"> = notesApi) {
  const initial = {
    notes: [] as Message[],
    nextCursor: null as string | null,
    status: "idle" as const,
    loadingMore: false,
    error: null as string | null,
    topic: null as string | null,
    topics: [] as MeetingTopicCount[],
  };
  // A reset (or another topic) while a request is out makes its answer stale.
  let generation = 0;
  return create<NotesHubState>()((set, get) => ({
    ...initial,

    async load() {
      const mine = ++generation;
      const { topic } = get();
      set({ status: "loading", error: null });
      void get().loadTopics();
      try {
        const page = await api.list(null, topic);
        if (mine !== generation) return;
        set({ notes: page.notes, nextCursor: page.nextCursor, status: "ready" });
      } catch (err) {
        if (mine === generation) set({ status: "error", error: failure(err) });
      }
    },

    async loadMore() {
      const { nextCursor, loadingMore, status, topic } = get();
      if (!nextCursor || loadingMore || status !== "ready") return;
      const mine = generation;
      set({ loadingMore: true, error: null });
      try {
        const page = await api.list(nextCursor, topic);
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

    async showTopic(topic) {
      if (topic === get().topic) return;
      set({ topic, notes: [], nextCursor: null });
      await get().load();
    },

    async loadTopics() {
      try {
        const topics = await api.topics();
        set({ topics });
      } catch {
        // The list still works; the topic filter just has nothing to offer.
      }
    },

    upsert(message) {
      const { status, topic } = get();
      if (message.kind !== "ai_notes" || status !== "ready" || !inTopic(message, topic)) return;
      set((s) => {
        const others = s.notes.filter((m) => !same(m, message.channelId, message.sk));
        return { notes: [...others, message].sort(newestFirst) };
      });
    },

    update(channelId, sk, aiNotes, text) {
      const before = get().notes.find((m) => same(m, channelId, sk));
      if (!before) return;
      set((s) => ({
        notes: s.notes.map((m) => (same(m, channelId, sk) ? { ...m, aiNotes, text } : m)),
      }));
      // Filed under another topic: the counts change.
      if ((before.aiNotes?.topic ?? "") !== (aiNotes.topic ?? "")) void get().loadTopics();
    },

    remove(channelId, sk) {
      if (!get().notes.some((m) => same(m, channelId, sk))) return;
      set((s) => ({ notes: s.notes.filter((m) => !same(m, channelId, sk)) }));
    },

    reset() {
      generation++;
      set(initial);
    },
  }));
}

export const useNotesHub = createNotesHub();
