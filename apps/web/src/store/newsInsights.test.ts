import type { NewsInsights } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import type { NewsInsightsApi } from "../lib/newsApi";
import { createNewsInsightsStore, INSIGHTS_POLL_MS } from "./newsInsights";

const insights = (generatedAt: number): NewsInsights => ({
  day: "2026-10-27",
  analysis: "## Lo esencial\n\n- algo",
  generatedAt,
  articles: [{ title: "A", link: "https://techcrunch.com/a" }],
  source: "TechCrunch",
});

describe("news insights store", () => {
  it("loads the latest once, then again only after 5 minutes or when forced", async () => {
    let t = 1_000_000;
    const api: NewsInsightsApi = {
      latest: vi.fn(async () => ({ insights: insights(1) })),
      generate: vi.fn(async () => ({ queued: true as const })),
    };
    const store = createNewsInsightsStore(api, () => t);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: "ready", insights: insights(1) });
    await store.getState().load();
    expect(api.latest).toHaveBeenCalledTimes(1);
    t += 5 * 60_000;
    await store.getState().load();
    expect(api.latest).toHaveBeenCalledTimes(2);
    await store.getState().load(true);
    expect(api.latest).toHaveBeenCalledTimes(3);
  });

  it("before the first analysis, ready with nothing; a failed load with nothing is an error", async () => {
    const empty: NewsInsightsApi = {
      latest: vi.fn(async () => ({ insights: null })),
      generate: vi.fn(),
    };
    const store = createNewsInsightsStore(empty);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: "ready", insights: null });

    const down: NewsInsightsApi = {
      latest: vi.fn(async () => Promise.reject(new Error("offline"))),
      generate: vi.fn(),
    };
    const failed = createNewsInsightsStore(down);
    await failed.getState().load();
    expect(failed.getState()).toMatchObject({ status: "error", error: "offline" });
  });

  it("generate: asks the server, then polls until a newer analysis appears", async () => {
    let t = 1_000_000;
    const latest = vi
      .fn()
      .mockResolvedValueOnce({ insights: insights(1) }) // the initial load
      .mockResolvedValueOnce({ insights: insights(1) }) // still the old one
      .mockResolvedValueOnce({ insights: insights(2) }); // the new one
    const api: NewsInsightsApi = {
      latest,
      generate: vi.fn(async () => ({ queued: true as const })),
    };
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const store = createNewsInsightsStore(api, () => t, sleep);
    await store.getState().load();
    await store.getState().generate();
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(INSIGHTS_POLL_MS);
    expect(store.getState()).toMatchObject({
      generating: false,
      generateError: null,
      insights: insights(2),
    });
  });

  it("generate: gives up after the wait, and reports a refused request", async () => {
    let t = 1_000_000;
    const api: NewsInsightsApi = {
      latest: vi.fn(async () => ({ insights: insights(1) })),
      generate: vi.fn(async () => ({ queued: true as const })),
    };
    const store = createNewsInsightsStore(
      api,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    await store.getState().load(); // the one on screen; the worker never writes a newer one
    await store.getState().generate();
    expect(store.getState()).toMatchObject({ generating: false, insights: insights(1) });
    expect(store.getState().generateError).toMatch(/longer than usual/);

    const refused: NewsInsightsApi = {
      latest: vi.fn(),
      generate: vi.fn(async () =>
        Promise.reject(new Error("Only an admin can ask for a new analysis")),
      ),
    };
    const other = createNewsInsightsStore(refused);
    await other.getState().generate();
    expect(other.getState()).toMatchObject({
      generating: false,
      generateError: "Only an admin can ask for a new analysis",
    });
  });
});
