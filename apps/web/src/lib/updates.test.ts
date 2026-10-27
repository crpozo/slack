import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  entryScriptOf,
  newVersionAvailable,
  watchForUpdates,
  type UpdateWatchPage,
} from "./updates";

/** A page whose visibility the test flips and whose events it fires. */
function fakePage(visibilityState: "visible" | "hidden" = "visible") {
  const listeners: Record<string, Set<() => void>> = {
    visibilitychange: new Set(),
    online: new Set(),
  };
  const page: Omit<UpdateWatchPage, "visibilityState"> & {
    visibilityState: "visible" | "hidden";
    fire: (type: "visibilitychange" | "online") => void;
  } = {
    visibilityState,
    addEventListener: (type, l) => listeners[type]!.add(l),
    removeEventListener: (type, l) => listeners[type]!.delete(l),
    fire: (type) => listeners[type]!.forEach((l) => l()),
  };
  return page;
}

const page = (bundle: string) =>
  `<!doctype html><html><head><script>window.x = 1;</script></head>
<body><div id="root"></div><script type="module" crossorigin src="${bundle}"></script></body></html>`;

const serving = (bundle: string, status = 200) =>
  vi.fn(
    async () => new Response(page(bundle), { status, headers: { "content-type": "text/html" } }),
  );

describe("entryScriptOf", () => {
  it("finds the module script's src, whatever the attribute order", () => {
    expect(entryScriptOf(page("/assets/index-abc123.js"))).toBe("/assets/index-abc123.js");
    expect(entryScriptOf(`<script src="/assets/index-x.js" type="module"></script>`)).toBe(
      "/assets/index-x.js",
    );
    expect(entryScriptOf(`<script src="/plain.js"></script>`)).toBeNull();
  });
});

describe("newVersionAvailable", () => {
  it("is true only when the server names a different bundle", async () => {
    expect(await newVersionAvailable(serving("/assets/index-new.js"), "/assets/index-old.js")).toBe(
      true,
    );
    expect(await newVersionAvailable(serving("/assets/index-old.js"), "/assets/index-old.js")).toBe(
      false,
    );
  });

  it("asks for index.html uncached", async () => {
    const fetchImpl = serving("/assets/index-old.js");
    await newVersionAvailable(fetchImpl, "/assets/index-old.js");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/index.html",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("never nags on a failed read, an odd page, or without a running bundle", async () => {
    expect(await newVersionAvailable(serving("/assets/index-new.js", 503), "/a.js")).toBe(false);
    expect(
      await newVersionAvailable(
        vi.fn(async () => Promise.reject(new Error("offline"))),
        "/a.js",
      ),
    ).toBe(false);
    expect(
      await newVersionAvailable(
        vi.fn(async () => new Response("<html></html>")),
        "/a.js",
      ),
    ).toBe(false);
    expect(await newVersionAvailable(serving("/assets/index-new.js"), null)).toBe(false);
  });
});

describe("watchForUpdates", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("checks on the interval, reports once, then stops", async () => {
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const onUpdate = vi.fn();
    watchForUpdates(onUpdate, { check, intervalMs: 1_000, minGapMs: 0, page: fakePage() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(check).toHaveBeenCalledTimes(2); // stopped after the first find
  });

  it("checks when the tab is shown again or back online, not twice within the minimum gap, never hidden", async () => {
    const check = vi.fn(async () => false);
    const page = fakePage();
    watchForUpdates(vi.fn(), { check, intervalMs: 60_000, minGapMs: 5_000, page });
    await vi.advanceTimersByTimeAsync(6_000);
    page.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    page.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    page.fire("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    page.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("stops when asked, and listens no more", async () => {
    const check = vi.fn(async () => false);
    const page = fakePage();
    const stop = watchForUpdates(vi.fn(), { check, intervalMs: 1_000, minGapMs: 0, page });
    stop();
    await vi.advanceTimersByTimeAsync(3_000);
    page.fire("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(check).not.toHaveBeenCalled();
  });
});
