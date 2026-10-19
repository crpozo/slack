import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const me = { userId: "u_me", email: "carlos@mindfultech.ec", displayName: "Carlos Pozo" };
const msg = (text: string, userId = "u_ana") => ({ userId, text });

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {}); // `[desktop]` traces
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("shouldNotify", async () => {
  const { shouldNotify } = await import("./desktop");

  it("notifies for every DM from someone else", () => {
    expect(shouldNotify({ type: "dm" }, msg("hi"), me)).toBe(true);
    expect(shouldNotify({ type: "dm" }, msg("hi", "u_me"), me)).toBe(false);
  });

  it("notifies for every private-channel message from someone else, like a DM", () => {
    expect(shouldNotify({ type: "private" }, msg("standup in 5"), me)).toBe(true);
    expect(shouldNotify({ type: "private" }, msg("mine", "u_me"), me)).toBe(false);
  });

  it("notifies in public channels only when you are @mentioned", () => {
    expect(shouldNotify({ type: "public" }, msg("hello all"), me)).toBe(false);
    expect(shouldNotify({ type: "public" }, msg("ping @CarlosPozo"), me)).toBe(true);
    expect(shouldNotify({ type: "public" }, msg("cc @carlos."), me)).toBe(true);
    expect(shouldNotify({ type: "public" }, msg("@carlos", "u_me"), me)).toBe(false);
    expect(shouldNotify(undefined, msg("@carlos"), me)).toBe(false);
  });
});

describe("notificationBody", async () => {
  const { notificationBody } = await import("./desktop");

  it("previews text, voice notes and files", () => {
    expect(notificationBody({ text: " a\n b ", attachments: [] })).toBe("a b");
    expect(notificationBody({ text: "x".repeat(300), attachments: [] })).toHaveLength(120);
    const voice = { contentType: "audio/webm" } as never;
    expect(notificationBody({ text: "", attachments: [voice] })).toBe("🎤 Voice message");
    expect(notificationBody({ text: "hunter2", attachments: [], isSecret: true })).toBe(
      "🔒 Secret sent",
    );
  });
});

/** A fake `window.__TAURI__` as the desktop app injects it. */
function fakeTauri(opts: { focused?: boolean; minimized?: boolean; permission?: boolean } = {}) {
  const focusHandlers: Array<(e: { payload: boolean }) => void> = [];
  const invoke = vi.fn().mockResolvedValue(undefined);
  const win = {
    isFocused: vi.fn().mockResolvedValue(opts.focused ?? false),
    isMinimized: vi.fn().mockResolvedValue(opts.minimized ?? false),
    onFocusChanged: vi.fn(async (h: (e: { payload: boolean }) => void) => {
      focusHandlers.push(h);
      return () => focusHandlers.splice(focusHandlers.indexOf(h), 1);
    }),
  };
  const notification = {
    isPermissionGranted: vi.fn().mockResolvedValue(opts.permission ?? true),
    requestPermission: vi.fn().mockResolvedValue("denied"),
  };
  vi.stubGlobal("window", {
    __TAURI__: { core: { invoke }, window: { getCurrentWindow: () => win }, notification },
  });
  return {
    invoke,
    win,
    notification,
    focus: (f: boolean) => focusHandlers.forEach((h) => h({ payload: f })),
  };
}

describe("notifyDesktop", () => {
  it("is a no-op outside the desktop app", async () => {
    vi.stubGlobal("window", {});
    const { isDesktopApp, notifyDesktop, desktopWindowFocused } = await import("./desktop");
    expect(isDesktopApp()).toBe(false);
    expect(await notifyDesktop("t", "b")).toBe(false);
    expect(await desktopWindowFocused()).toBeNull();
  });

  it("asks Tauri (not the DOM) whether the window is in the background, then calls notify", async () => {
    const { invoke, win } = fakeTauri({ focused: false });
    const { notifyDesktop } = await import("./desktop");
    expect(await notifyDesktop("Ana", "hi")).toBe(true);
    expect(win.isFocused).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", {
      options: { title: "Ana", body: "hi" },
    });
  });

  it("notifies when the window is focused but minimized, never when it's in front", async () => {
    const minimized = fakeTauri({ focused: true, minimized: true });
    let mod = await import("./desktop");
    expect(await mod.notifyDesktop("Ana", "hi")).toBe(true);
    expect(minimized.invoke).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const front = fakeTauri({ focused: true });
    mod = await import("./desktop");
    expect(await mod.notifyDesktop("Ana", "hi")).toBe(false);
    expect(front.invoke).not.toHaveBeenCalled();
  });

  it("asks for permission once and stays quiet when the OS says no", async () => {
    const { invoke, notification } = fakeTauri({ permission: false });
    const { notifyDesktop } = await import("./desktop");
    expect(await notifyDesktop("Ana", "hi")).toBe(false);
    expect(await notifyDesktop("Ana", "again")).toBe(false);
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a failed notify instead of throwing", async () => {
    const { invoke } = fakeTauri();
    invoke.mockRejectedValue(new Error("not allowed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { notifyDesktop } = await import("./desktop");
    expect(await notifyDesktop("Ana", "hi")).toBe(false);
    expect(warn).toHaveBeenCalledWith("[desktop] notification failed", expect.any(Error));
  });
});

describe("watchDesktopFocus", () => {
  it("reports the current focus, then every change, until stopped", async () => {
    const tauri = fakeTauri({ focused: true });
    const { watchDesktopFocus } = await import("./desktop");
    const seen: boolean[] = [];
    const stop = watchDesktopFocus((f) => seen.push(f));
    await vi.waitFor(() => expect(seen).toEqual([true]));
    tauri.focus(false);
    expect(seen).toEqual([true, false]);
    stop();
    tauri.focus(true);
    expect(seen).toEqual([true, false]);
  });
});
