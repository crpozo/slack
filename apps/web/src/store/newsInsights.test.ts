import type { NewsInsights } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsInsightsApi } from "../lib/newsApi";
import { createNewsInsightsStore, INSIGHTS_POLL_MS } from "./newsInsights";

const insights = (generatedAt: number): NewsInsights => ({
  day: "2026-10-27",
  generatedAt,
  storyCount: 1,
  stories: [],
  trends: [{ topic: "Agentes", text: "algo" }],
  takeaways: [{ lead: "Probar", body: "algo" }],
  articles: [{ title: "A", link: "https://techcrunch.com/a" }],
  source: "TechCrunch",
});

describe("news insights store", () => {
  it("follows an audio being made until it's there (Phase 55)", async () => {
    const audio = { url: "https://bucket/news-audio/a.mp3", seconds: 150 };
    const latest = vi
      .fn()
      .mockResolvedValueOnce({ insights: insights(1), audioPending: true })
      .mockResolvedValueOnce({ insights: insights(1), audioPending: true })
      .mockResolvedValueOnce({ insights: { ...insights(1), audio } });
    const slept: number[] = [];
    const store = createNewsInsightsStore(
      { latest, refresh: vi.fn() },
      () => 1,
      async (ms) => void slept.push(ms),
    );
    await store.getState().load();
    expect(store.getState().audioPending).toBe(true);
    await vi.waitFor(() => expect(store.getState().insights?.audio).toEqual(audio));
    expect(store.getState().audioPending).toBe(false);
    expect(latest).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10_000, 10_000]);
  });

  it("loads the latest once, then again only after 5 minutes or when forced", async () => {
    let t = 1_000_000;
    const api: NewsInsightsApi = {
      latest: vi.fn(async () => ({ insights: insights(1) })),
      refresh: vi.fn(async () => ({ queued: true })),
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
      refresh: vi.fn(),
    };
    const store = createNewsInsightsStore(empty);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: "ready", insights: null });

    const down: NewsInsightsApi = {
      latest: vi.fn(async () => Promise.reject(new Error("offline"))),
      refresh: vi.fn(),
    };
    const failed = createNewsInsightsStore(down);
    await failed.getState().load();
    expect(failed.getState()).toMatchObject({ status: "error", error: "offline" });
  });

  it("generate: when one was started a moment ago, says when the next may be asked for", async () => {
    const api: NewsInsightsApi = {
      latest: vi.fn(async () => ({ insights: insights(1) })),
      refresh: vi.fn(async () => ({ queued: false, retryAfterSeconds: 170 })),
    };
    const store = createNewsInsightsStore(api);
    await store.getState().generate();
    expect(store.getState()).toMatchObject({
      generating: false,
      generateError: null,
      generateNotice: "El análisis se pidió hace un momento: podrás pedir otro en 3 min.",
    });
    expect(api.latest).toHaveBeenCalled(); // shows the one that's being written, once it's there
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
      refresh: vi.fn(async () => ({ queued: true })),
    };
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const store = createNewsInsightsStore(api, () => t, sleep);
    await store.getState().load();
    await store.getState().generate();
    expect(api.refresh).toHaveBeenCalledTimes(1);
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
      refresh: vi.fn(async () => ({ queued: true })),
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
    expect(store.getState().generateError).toMatch(/tardando más de lo normal/);

    const refused: NewsInsightsApi = {
      latest: vi.fn(),
      refresh: vi.fn(async () => Promise.reject(new Error("Service Unavailable"))),
    };
    const other = createNewsInsightsStore(refused);
    await other.getState().generate();
    expect(other.getState()).toMatchObject({
      generating: false,
      generateError: "Service Unavailable",
    });
  });
});

describe("news insights store: a running analysis survives the page (Phase 49)", () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("remembers the request while it waits, and forgets it once the analysis is there", async () => {
    let t = 1_000_000;
    let seen: string | undefined;
    const latest = vi
      .fn()
      .mockImplementationOnce(async () => {
        seen = stored["news.insights.pending"];
        return { insights: insights(1) };
      })
      .mockResolvedValue({ insights: insights(2) });
    const api: NewsInsightsApi = { latest, refresh: vi.fn(async () => ({ queued: true })) };
    const store = createNewsInsightsStore(
      api,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    await store.getState().generate();
    expect(JSON.parse(seen!)).toEqual({ since: 1_000_000, before: 0 });
    expect(stored["news.insights.pending"]).toBeUndefined();
    expect(store.getState()).toMatchObject({ generating: false, generatingSince: null });
  });

  it("resume: a fresh page picks the wait up from where it was, with the same start", async () => {
    stored["news.insights.pending"] = JSON.stringify({ since: 990_000, before: 1 });
    let t = 1_000_000;
    let during: unknown;
    const api: NewsInsightsApi = {
      latest: vi.fn(async () => {
        during = store.getState().generatingSince;
        return { insights: insights(2) };
      }),
      refresh: vi.fn(),
    };
    const store = createNewsInsightsStore(
      api,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    await store.getState().resume();
    expect(during).toBe(990_000);
    expect(api.refresh).not.toHaveBeenCalled(); // the worker is already running
    expect(store.getState()).toMatchObject({ generating: false, insights: insights(2) });
  });

  it("stops waiting as soon as the server says the run failed, and says why", async () => {
    let t = 1_000_000;
    const api: NewsInsightsApi = {
      latest: vi.fn(async () => ({
        insights: insights(1),
        failure: { error: "El servicio de IA está ocupado.", at: 1_000_500 },
      })),
      refresh: vi.fn(async () => ({ queued: true })),
    };
    const store = createNewsInsightsStore(
      api,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    await store.getState().generate();
    expect(api.latest).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      generating: false,
      generateError: "El análisis no se pudo escribir: El servicio de IA está ocupado.",
    });
    expect(stored["news.insights.pending"]).toBeUndefined();
  });

  it("resume: nothing pending, or too old, does nothing", async () => {
    const api: NewsInsightsApi = { latest: vi.fn(), refresh: vi.fn() };
    const store = createNewsInsightsStore(api, () => 10_000_000);
    await store.getState().resume();
    stored["news.insights.pending"] = JSON.stringify({ since: 1, before: 0 });
    await store.getState().resume();
    expect(api.latest).not.toHaveBeenCalled();
    expect(stored["news.insights.pending"]).toBeUndefined();
    expect(store.getState().generating).toBe(false);
  });
});
