import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let desktopFocus: ((focused: boolean) => void) | null = null;
vi.mock("./desktop", () => ({
  watchDesktopFocus: (fn: (focused: boolean) => void) => {
    desktopFocus = fn;
    return () => (desktopFocus = null);
  },
}));

/** A document that, like WebView2 on Windows, always claims to be visible and focused. */
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true }),
  );
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("isAppActive", () => {
  it("follows the page's focus and visibility in a browser", async () => {
    const { isAppActive } = await import("./activity");
    expect(isAppActive()).toBe(true);
    vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => true });
    expect(isAppActive()).toBe(false);
  });

  it("in the desktop app, trusts Tauri's window focus over the DOM", async () => {
    const { isAppActive, watchActivity } = await import("./activity");
    const changes: boolean[] = [];
    const stop = watchActivity((a) => changes.push(a));
    desktopFocus?.(false); // window behind another app; the DOM still says focused
    expect(isAppActive()).toBe(false);
    desktopFocus?.(true);
    expect(isAppActive()).toBe(true);
    expect(changes).toEqual([false, true]);
    stop();
    expect(desktopFocus).toBeNull();
  });
});
