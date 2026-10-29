import type { SearchResponse } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageSearch, type MessageSearchState } from "./messageSearch";

const answer = (q: string): SearchResponse => ({ results: [], terms: [q], truncated: false });

describe("createMessageSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends one request after a 300 ms pause in typing, not one per key", async () => {
    const run = vi.fn(async (q: string) => answer(q));
    const states: MessageSearchState[] = [];
    const search = createMessageSearch(run, (s) => states.push(s));
    for (const q of ["l", "lo", "log", "logi", "login"]) {
      search.update(q);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("login");
    expect(states.at(-1)).toEqual({ status: "done", query: "login", response: answer("login") });
    expect(states[0]).toEqual({ status: "idle" }); // "l" alone is too short to search
  });

  it("drops a slow answer to an older query", async () => {
    let resolveOld: (r: SearchResponse) => void = () => {};
    const run = vi
      .fn<(q: string) => Promise<SearchResponse>>()
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockImplementation(async (q) => answer(q));
    const states: MessageSearchState[] = [];
    const search = createMessageSearch(run, (s) => states.push(s));
    search.update("deploy");
    await vi.advanceTimersByTimeAsync(300); // "deploy" sent, still waiting
    search.update("release");
    await vi.advanceTimersByTimeAsync(300);
    resolveOld(answer("deploy"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ status: "done", query: "release" });
    expect(states.some((s) => s.status === "done" && s.query === "deploy")).toBe(false);
  });

  it("answers a query asked again from memory, keeps results on screen while loading, reports errors", async () => {
    const run = vi.fn(async (q: string) => answer(q));
    const states: MessageSearchState[] = [];
    const search = createMessageSearch(run, (s) => states.push(s));
    search.update("bug");
    await vi.advanceTimersByTimeAsync(300);
    search.update("bugs");
    expect(states.at(-1)).toEqual({ status: "loading", query: "bugs", previous: answer("bug") });
    search.update("  BUG ");
    expect(states.at(-1)).toEqual({ status: "done", query: "BUG", response: answer("bug") });
    expect(run).toHaveBeenCalledTimes(1);

    const failing = createMessageSearch(
      async () => Promise.reject(new Error("offline")),
      (s) => states.push(s),
    );
    failing.update("crash");
    await vi.advanceTimersByTimeAsync(300);
    expect(states.at(-1)).toEqual({ status: "error", query: "crash", error: "offline" });
  });

  it("stops a pending request when disposed", async () => {
    const run = vi.fn(async (q: string) => answer(q));
    const search = createMessageSearch(run, () => {});
    search.update("login");
    search.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
