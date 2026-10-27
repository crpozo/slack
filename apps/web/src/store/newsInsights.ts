import { NEWS_INSIGHTS_WAIT_MS, type NewsInsights } from "@mindfultech/shared";
import { create } from "zustand";
import { newsInsightsApi, type NewsInsightsApi } from "../lib/newsApi";

/** A loaded analysis is reused this long before being asked for again. */
export const INSIGHTS_FRESH_MS = 5 * 60_000;
/** While a requested analysis is being written, the view asks this often whether it's there. */
export const INSIGHTS_POLL_MS = 5_000;

/**
 * The AI Insights section's data (Phase 39): the latest morning analysis,
 * loaded when the News view opens; and an admin's "Generate now", which
 * starts the worker and waits for the new row to appear.
 */
export interface NewsInsightsState {
  status: "idle" | "loading" | "ready" | "error";
  insights: NewsInsights | null;
  error: string | null;
  loadedAt: number;
  /** A fresh analysis was requested and hasn't arrived yet. */
  generating: boolean;
  /** Why the last request didn't produce one (shown until the next attempt). */
  generateError: string | null;
  load: (force?: boolean) => Promise<void>;
  generate: () => Promise<void>;
  reset: () => void;
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function createNewsInsightsStore(
  api: NewsInsightsApi,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  return create<NewsInsightsState>((set, get) => ({
    status: "idle",
    insights: null,
    error: null,
    loadedAt: 0,
    generating: false,
    generateError: null,
    load: async (force = false) => {
      const s = get();
      if (s.status === "loading") return;
      if (!force && s.loadedAt && now() - s.loadedAt < INSIGHTS_FRESH_MS) return;
      set({ status: "loading", error: null });
      try {
        const { insights } = await api.latest();
        set({ status: "ready", insights, loadedAt: now() });
      } catch (err) {
        set({
          status: get().loadedAt ? "ready" : "error",
          error: message(err, "Couldn't load the insights."),
        });
      }
    },
    generate: async () => {
      if (get().generating) return;
      const before = get().insights?.generatedAt ?? 0;
      set({ generating: true, generateError: null });
      try {
        await api.generate();
        const deadline = now() + NEWS_INSIGHTS_WAIT_MS;
        while (now() < deadline) {
          await sleep(INSIGHTS_POLL_MS);
          const { insights } = await api.latest();
          if (insights && insights.generatedAt > before) {
            set({ insights, status: "ready", loadedAt: now(), generating: false });
            return;
          }
        }
        set({
          generating: false,
          generateError: "The analysis is taking longer than usual. Check back in a minute.",
        });
      } catch (err) {
        set({ generating: false, generateError: message(err, "Couldn't request the analysis.") });
      }
    },
    reset: () =>
      set({
        status: "idle",
        insights: null,
        error: null,
        loadedAt: 0,
        generating: false,
        generateError: null,
      }),
  }));
}

export const useNewsInsights = createNewsInsightsStore(newsInsightsApi);
