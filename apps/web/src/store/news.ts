import { NEWS_CACHE_SECONDS, type NewsResponse } from "@mindfultech/shared";
import { create } from "zustand";
import { newsApi, type NewsApi } from "../lib/newsApi";

/**
 * The AI News view's data (Phase 35b): loaded when the view opens, kept for
 * the session, and asked for again once older than the server's cache (the
 * browser answers repeats from its own cache meanwhile).
 */
export interface NewsState {
  status: "idle" | "loading" | "ready" | "error";
  data: NewsResponse | null;
  error: string | null;
  /** When it was last loaded (epoch ms). */
  loadedAt: number;
  /** Loads unless what we have is still fresh (`force`: always). */
  load: (force?: boolean) => Promise<void>;
  reset: () => void;
}

export function createNewsStore(api: NewsApi, now: () => number = Date.now) {
  return create<NewsState>((set, get) => ({
    status: "idle",
    data: null,
    error: null,
    loadedAt: 0,
    load: async (force = false) => {
      const s = get();
      if (s.status === "loading") return;
      if (!force && s.data && now() - s.loadedAt < NEWS_CACHE_SECONDS * 1000) return;
      set({ status: "loading", error: null });
      try {
        const data = await api.list();
        set({ status: "ready", data, loadedAt: now() });
      } catch (err) {
        set({
          // What we had stays on screen; the error says why it isn't newer.
          status: get().data ? "ready" : "error",
          error: err instanceof Error ? err.message : "Couldn't load the news.",
        });
      }
    },
    reset: () => set({ status: "idle", data: null, error: null, loadedAt: 0 }),
  }));
}

export const useNews = createNewsStore(newsApi);
