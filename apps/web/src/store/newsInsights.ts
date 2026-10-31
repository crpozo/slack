import { NEWS_INSIGHTS_WAIT_MS, type NewsInsights } from "@mindfultech/shared";
import { create } from "zustand";
import { newsInsightsApi, type NewsInsightsApi } from "../lib/newsApi";

/** How long an analysis usually takes: the progress bar is paced on it (Phase 49). */
export const INSIGHTS_EXPECTED_MS = 90_000;

/**
 * Where a running analysis is remembered for this tab (Phase 49): the worker
 * keeps going on the server whatever the page does, so a reload or a visit
 * elsewhere picks the wait up again instead of forgetting it.
 */
const PENDING_KEY = "news.insights.pending";

interface PendingAnalysis {
  /** When it was asked for (epoch ms). */
  since: number;
  /** The `generatedAt` of the analysis on screen then: a newer one is the answer. */
  before: number;
}

function readPending(): PendingAnalysis | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    const p = raw as Partial<PendingAnalysis> | null;
    return typeof p?.since === "number" && typeof p.before === "number"
      ? { since: p.since, before: p.before }
      : null;
  } catch {
    return null;
  }
}

function writePending(pending: PendingAnalysis | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Not remembered: the wait still runs while this page is open.
  }
}

/** A loaded analysis is reused this long before being asked for again. */
export const INSIGHTS_FRESH_MS = 5 * 60_000;
/** While a requested analysis is being written, the view asks this often whether it's there. */
export const INSIGHTS_POLL_MS = 5_000;

/**
 * The AI Insights section's data (Phase 39): the latest morning analysis,
 * loaded when the News view opens; and "Refresh news" (or an admin's
 * "Generar análisis"), which starts the worker and waits for the new row.
 */
export interface NewsInsightsState {
  status: "idle" | "loading" | "ready" | "error";
  insights: NewsInsights | null;
  error: string | null;
  loadedAt: number;
  /** A fresh analysis was requested and hasn't arrived yet. */
  generating: boolean;
  /** When it was requested (epoch ms), for the progress bar; `null` when none is. */
  generatingSince: number | null;
  /** Why the last request didn't produce one (shown until the next attempt). */
  generateError: string | null;
  /** The last request wasn't needed: one was started a moment ago. */
  generateNotice: string | null;
  load: (force?: boolean) => Promise<void>;
  generate: () => Promise<void>;
  /**
   * Picks up an analysis asked for earlier in this tab (before a reload) and
   * waits for it, if it isn't too old. Safe to call often.
   */
  resume: () => Promise<void>;
  reset: () => void;
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function createNewsInsightsStore(
  api: NewsInsightsApi,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  return create<NewsInsightsState>((set, get) => {
    /** Polls until an analysis newer than `before` is there, or `deadline` passes. */
    async function waitFor(before: number, deadline: number): Promise<void> {
      while (now() < deadline) {
        await sleep(INSIGHTS_POLL_MS);
        const { insights } = await api.latest();
        if (insights && insights.generatedAt > before) {
          writePending(null);
          set({
            insights,
            status: "ready",
            loadedAt: now(),
            generating: false,
            generatingSince: null,
          });
          return;
        }
      }
      writePending(null);
      set({
        generating: false,
        generatingSince: null,
        generateError: "El análisis está tardando más de lo normal. Vuelve a mirar en un minuto.",
      });
    }
    return {
      status: "idle",
      insights: null,
      error: null,
      loadedAt: 0,
      generating: false,
      generatingSince: null,
      generateError: null,
      generateNotice: null,
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
        const since = now();
        set({
          generating: true,
          generatingSince: since,
          generateError: null,
          generateNotice: null,
        });
        try {
          const started = await api.refresh();
          if (!started.queued) {
            const minutes = Math.max(1, Math.ceil((started.retryAfterSeconds ?? 60) / 60));
            set({
              generating: false,
              generatingSince: null,
              generateNotice: `El análisis se pidió hace un momento: podrás pedir otro en ${minutes} min.`,
            });
            void get().load(true);
            return;
          }
          writePending({ since, before });
          await waitFor(before, since + NEWS_INSIGHTS_WAIT_MS);
        } catch (err) {
          writePending(null);
          set({
            generating: false,
            generatingSince: null,
            generateError: message(err, "No se pudo pedir el análisis."),
          });
        }
      },
      resume: async () => {
        const pending = readPending();
        if (!pending || get().generating) return;
        const deadline = pending.since + NEWS_INSIGHTS_WAIT_MS;
        if (now() >= deadline) {
          writePending(null);
          return;
        }
        set({ generating: true, generatingSince: pending.since, generateError: null });
        try {
          await waitFor(pending.before, deadline);
        } catch (err) {
          writePending(null);
          set({
            generating: false,
            generatingSince: null,
            generateError: message(err, "No se pudo seguir el análisis."),
          });
        }
      },
      reset: () =>
        set({
          status: "idle",
          insights: null,
          error: null,
          loadedAt: 0,
          generating: false,
          generatingSince: null,
          generateError: null,
          generateNotice: null,
        }),
    };
  });
}

export const useNewsInsights = createNewsInsightsStore(newsInsightsApi);
