import {
  PLATFORM_INSIGHTS_WAIT_MS,
  type PlatformInsightsAccess,
  type PlatformInsightsResponse,
  type PlatformInsightsStarted,
  type PlatformReport,
} from "@mindfultech/shared";
import { create } from "zustand";
import { request } from "../lib/tasksApi";

// ---------------------------------------------------------------------------
// Platform Insights (Phase 64): only its owners see the section. Whether this
// person does is asked once per session; the rest is loaded when it's opened.
// ---------------------------------------------------------------------------

const POLL_MS = 4_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PlatformInsightsState {
  /** `null` until asked; `false` for everyone but the owners. */
  allowed: boolean | null;
  status: "idle" | "loading" | "ready" | "error";
  report: PlatformReport | null;
  generating: boolean;
  error: string | null;
  checkAccess: () => Promise<void>;
  load: () => Promise<void>;
  generate: () => Promise<void>;
}

export const usePlatformInsights = create<PlatformInsightsState>((set, get) => {
  /** Polls until a report newer than `before` is there, or the run reports an error. */
  async function waitFor(before: number, since: number) {
    while (Date.now() - since < PLATFORM_INSIGHTS_WAIT_MS) {
      await sleep(POLL_MS);
      const latest = await request<PlatformInsightsResponse>("GET", "/platform-insights");
      if (latest.report && latest.report.generatedAt > before) {
        set({ report: latest.report, generating: false, error: null, status: "ready" });
        return;
      }
      if (!latest.generatingSince) {
        set({ generating: false, error: latest.error ?? "No se pudo escribir el informe." });
        return;
      }
    }
    set({ generating: false, error: "El informe está tardando demasiado. Vuelve a intentarlo." });
  }
  return {
    allowed: null,
    status: "idle",
    report: null,
    generating: false,
    error: null,
    checkAccess: async () => {
      if (get().allowed !== null) return;
      try {
        const { allowed } = await request<PlatformInsightsAccess>(
          "GET",
          "/platform-insights/access",
        );
        set({ allowed });
      } catch {
        // Not known this time: the section stays hidden, and it's asked again later.
      }
    },
    load: async () => {
      if (get().status === "loading") return;
      set({ status: "loading", error: null });
      try {
        const latest = await request<PlatformInsightsResponse>("GET", "/platform-insights");
        set({ status: "ready", report: latest.report, error: latest.error ?? null });
        if (latest.generatingSince && !get().generating) {
          set({ generating: true });
          void waitFor(latest.report?.generatedAt ?? 0, latest.generatingSince).catch(() =>
            set({ generating: false }),
          );
        }
      } catch (err) {
        set({
          status: "error",
          error: err instanceof Error ? err.message : "No se pudo cargar el informe.",
        });
      }
    },
    generate: async () => {
      if (get().generating) return;
      const before = get().report?.generatedAt ?? 0;
      set({ generating: true, error: null });
      try {
        await request<PlatformInsightsStarted>("POST", "/platform-insights");
        await waitFor(before, Date.now());
      } catch (err) {
        set({
          generating: false,
          error: err instanceof Error ? err.message : "No se pudo pedir el informe.",
        });
      }
    },
  };
});
