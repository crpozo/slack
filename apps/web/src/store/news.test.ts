import type { NewsResponse } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import type { NewsApi } from "../lib/newsApi";
import { createNewsStore } from "./news";

const response = (title = "Story"): NewsResponse => ({
  source: "TechCrunch",
  fetchedAt: 1,
  articles: [
    {
      title,
      link: "https://techcrunch.com/a",
      snippet: "s",
      pubDate: null,
      imageUrl: null,
      sourceName: "TechCrunch",
    },
  ],
});

describe("news store", () => {
  it("loads once, then again only when older than 30 minutes or forced", async () => {
    let t = 1_000;
    const api: NewsApi = { list: vi.fn(async () => response()) };
    const store = createNewsStore(api, () => t);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: "ready", error: null });
    await store.getState().load();
    expect(api.list).toHaveBeenCalledTimes(1);
    t += 30 * 60_000;
    await store.getState().load();
    expect(api.list).toHaveBeenCalledTimes(2);
    await store.getState().load(true);
    expect(api.list).toHaveBeenCalledTimes(3);
    // Only the forced load (the Refresh button) asks the server to read the feed again.
    expect(vi.mocked(api.list).mock.calls.map(([refresh]) => refresh)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("an error with nothing loaded is an error; with articles on screen, they stay", async () => {
    const api: NewsApi = {
      list: vi.fn(async () => Promise.reject(new Error("Couldn't reach TechCrunch"))),
    };
    const store = createNewsStore(api);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: "error", error: "Couldn't reach TechCrunch" });

    const flaky: NewsApi = {
      list: vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("offline")),
    };
    const kept = createNewsStore(flaky);
    await kept.getState().load();
    await kept.getState().load(true);
    expect(kept.getState()).toMatchObject({ status: "ready", error: "offline" });
    expect(kept.getState().data?.articles).toHaveLength(1);
  });
});
