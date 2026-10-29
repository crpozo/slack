import { describe, expect, it, vi } from "vitest";
import { externalLinkOf, isExternalUrl, openExternal } from "./external";

const APP = "https://slack.mindfultech.ec";

describe("external links", () => {
  it("knows what leaves the app", () => {
    expect(isExternalUrl("https://github.com/x", APP)).toBe(true);
    expect(isExternalUrl("http://example.com", APP)).toBe(true);
    expect(isExternalUrl("mailto:ana@example.com", APP)).toBe(true);
    expect(isExternalUrl("tel:+593999", APP)).toBe(true);
    expect(isExternalUrl("https://slack.mindfultech.ec/app/ch_general", APP)).toBe(false);
    expect(isExternalUrl("/app/tasks", APP)).toBe(false);
    expect(isExternalUrl("javascript:alert(1)", APP)).toBe(false);
    expect(isExternalUrl("blob:https://slack.mindfultech.ec/x", APP)).toBe(false);
    expect(isExternalUrl("http://[bad", APP)).toBe(false);
  });

  it("finds the external link a click landed on, skipping downloads and app links", () => {
    // Node test environment: no DOM, so `Element` is faked just enough.
    vi.stubGlobal(
      "Element",
      class {
        closest() {
          return null;
        }
      },
    );
    const make = (attrs: Record<string, string>) => {
      const target = new (globalThis as unknown as { Element: new () => object }).Element();
      (target as { closest: () => unknown }).closest = () => ({
        getAttribute: (n: string) => attrs[n] ?? null,
        hasAttribute: (n: string) => n in attrs,
      });
      return target as EventTarget;
    };
    expect(externalLinkOf(make({ href: "https://github.com/x" }), APP)).toBe(
      "https://github.com/x",
    );
    expect(externalLinkOf(make({ href: "/app/ch_general" }), APP)).toBeNull();
    expect(externalLinkOf(make({ href: "https://s3.example/f", download: "" }), APP)).toBeNull();
    expect(externalLinkOf(null, APP)).toBeNull();
  });

  it("on the web opens a new tab, nothing else", async () => {
    const openWindow = vi.fn(() => null);
    const invoke = vi.fn();
    await openExternal("https://github.com", { desktop: false, openWindow, invoke });
    expect(openWindow).toHaveBeenCalledWith("https://github.com");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("in the desktop app asks the opener plugin for the OS browser", async () => {
    const invoke = vi.fn(async () => undefined);
    const openWindow = vi.fn(() => null);
    await openExternal("https://github.com", { desktop: true, invoke, openWindow });
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://github.com" });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("an older desktop build falls back to window.open, and a null from it is no failure", async () => {
    const denied = vi.fn(async () => {
      throw new Error("opener.open_url not allowed");
    });
    const routed = vi.fn(() => null); // the desktop app opened it in the browser: no window here
    await openExternal("https://github.com", { desktop: true, invoke: denied, openWindow: routed });
    expect(routed).toHaveBeenCalledWith("https://github.com");
    // Without the plugin at all, the same.
    const fallback = vi.fn(() => null);
    await openExternal("https://x.ec", { desktop: true, invoke: undefined, openWindow: fallback });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("an opener that errors after running isn't followed by a second open", async () => {
    const failedLate = vi.fn(async () => {
      throw new Error("xdg-open exited with status 3");
    });
    const openWindow = vi.fn(() => null);
    await openExternal("https://github.com", { desktop: true, invoke: failedLate, openWindow });
    expect(openWindow).not.toHaveBeenCalled();
  });
});
