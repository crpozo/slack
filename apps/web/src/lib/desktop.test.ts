import { afterEach, describe, expect, it, vi } from "vitest";

const me = { userId: "u_me", email: "carlos@mindfultech.ec", displayName: "Carlos Pozo" };
const msg = (text: string, userId = "u_ana") => ({ userId, text });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("shouldNotify", async () => {
  const { shouldNotify } = await import("./desktop");

  it("notifies for every DM from someone else", () => {
    expect(shouldNotify({ type: "dm" }, msg("hi"), me)).toBe(true);
    expect(shouldNotify({ type: "dm" }, msg("hi", "u_me"), me)).toBe(false);
  });

  it("notifies in channels only when you are @mentioned", () => {
    expect(shouldNotify({ type: "public" }, msg("hello all"), me)).toBe(false);
    expect(shouldNotify({ type: "public" }, msg("ping @CarlosPozo"), me)).toBe(true);
    expect(shouldNotify({ type: "private" }, msg("cc @carlos."), me)).toBe(true);
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
  });
});

describe("notifyDesktop", () => {
  it("is a no-op outside the desktop app", async () => {
    vi.stubGlobal("window", {});
    const { isDesktopApp, notifyDesktop } = await import("./desktop");
    expect(isDesktopApp()).toBe(false);
    await expect(notifyDesktop("t", "b")).resolves.toBeUndefined();
  });

  it("asks for permission once, then sends through the Tauri plugin", async () => {
    const notification = {
      isPermissionGranted: vi.fn().mockResolvedValue(false),
      requestPermission: vi.fn().mockResolvedValue("granted"),
      sendNotification: vi.fn(),
    };
    vi.stubGlobal("window", { __TAURI__: { notification } });
    const { isDesktopApp, notifyDesktop } = await import("./desktop");
    expect(isDesktopApp()).toBe(true);
    await notifyDesktop("Ana", "hi");
    await notifyDesktop("Ana", "again");
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(notification.sendNotification).toHaveBeenCalledWith({ title: "Ana", body: "again" });
  });

  it("stays quiet when the OS says no", async () => {
    const notification = {
      isPermissionGranted: vi.fn().mockResolvedValue(false),
      requestPermission: vi.fn().mockResolvedValue("denied"),
      sendNotification: vi.fn(),
    };
    vi.stubGlobal("window", { __TAURI__: { notification } });
    const { notifyDesktop } = await import("./desktop");
    await notifyDesktop("Ana", "hi");
    expect(notification.sendNotification).not.toHaveBeenCalled();
  });
});
