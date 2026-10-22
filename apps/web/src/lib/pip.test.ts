import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { CallView } from "./call";
import {
  createPipController,
  pipStrategies,
  showsOutside,
  type PipAdapter,
  type PipAdapters,
  type PipEnv,
  type PipState,
  type PipStrategy,
} from "./pip";

const call = (phase: CallView["phase"] = "connected"): CallView =>
  ({
    callId: "c1",
    channelId: "dm_a_b",
    peerId: "u-b",
    media: "video",
    phase,
    micOn: true,
    camOn: true,
    sharing: false,
    localCamera: null,
    localScreen: null,
    remoteStream: null,
    remoteScreen: null,
    canShare: true,
    peer: { micOn: true, camOn: true, sharing: false },
    connectedAt: phase === "connected" ? 1 : null,
    micDeviceId: null,
    cameraDeviceId: null,
    notes: {
      on: false,
      changedBy: null,
      local: { kind: "off" },
      onDevice: false,
      phrases: 0,
      full: false,
    },
  }) as CallView;

const ALL: PipEnv = { desktopApp: true, documentPip: true, videoPip: true };

function fakeAdapter(opts: { fails?: boolean } = {}) {
  let closed: (() => void) | null = null;
  const adapter: PipAdapter & { closedByUser(): void; open: ReturnType<typeof vi.fn> } = {
    open: vi.fn(async (onClosed: () => void) => {
      if (opts.fails) throw new Error("nope");
      closed = onClosed;
      return null;
    }),
    close: vi.fn(async () => {}),
    closedByUser: () => closed?.(),
  };
  return adapter;
}

function harness(env: PipEnv, failing: PipStrategy[] = []) {
  const store = create<PipState>(() => ({ active: null, reason: null, pipWindow: null }));
  const callStore = create<{ call: CallView | null }>(() => ({ call: call() }));
  const adapters = {
    tauri: fakeAdapter({ fails: failing.includes("tauri") }),
    document: fakeAdapter({ fails: failing.includes("document") }),
    video: fakeAdapter({ fails: failing.includes("video") }),
  };
  let focusHandler: ((focused: boolean) => void) | null = null;
  const listeners: Record<string, () => void> = {};
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (name: string, fn: () => void) => {
      listeners[name] = fn;
    },
    removeEventListener: () => {},
  };
  const mediaSession = { setActionHandler: vi.fn() };
  const controller = createPipController(adapters as unknown as PipAdapters, env, {
    store: store as unknown as typeof import("./pip").usePip,
    callStore: callStore as unknown as typeof import("./call").useCall,
    watchFocus: (fn) => {
      focusHandler = fn;
      return () => {};
    },
    mediaSession,
    doc,
    log: () => {},
  });
  return {
    store,
    callStore,
    adapters,
    controller,
    focus: (f: boolean) => focusHandler?.(f),
    doc,
    listeners,
    mediaSession,
  };
}

describe("pipStrategies", () => {
  it("prefers the desktop app's window, then Document PiP, then the video's, else nothing", () => {
    expect(pipStrategies(ALL)).toEqual(["tauri", "document", "video"]);
    expect(pipStrategies({ desktopApp: false, documentPip: true, videoPip: true })).toEqual([
      "document",
      "video",
    ]);
    expect(pipStrategies({ desktopApp: false, documentPip: false, videoPip: true })).toEqual([
      "video",
    ]);
    expect(pipStrategies({ desktopApp: false, documentPip: false, videoPip: false })).toEqual([]);
  });

  it("never shows a ringing call outside", () => {
    expect(showsOutside(null)).toBe(false);
    expect(showsOutside(call("incoming"))).toBe(false);
    expect(showsOutside(call("outgoing"))).toBe(true);
  });
});

describe("pip controller", () => {
  it("pops out with the best strategy on a click and falls through when one fails", async () => {
    const h = harness(ALL, ["tauri"]);
    expect(await h.controller.popOut("user")).toBe("document");
    expect(h.adapters.tauri.open).toHaveBeenCalledTimes(1);
    expect(h.adapters.document.open).toHaveBeenCalledTimes(1);
    expect(h.adapters.video.open).not.toHaveBeenCalled();
    expect(h.store.getState()).toMatchObject({ active: "document", reason: "user" });
    // Already out: a second request is a no-op.
    expect(await h.controller.popOut("user")).toBe("document");
    expect(h.adapters.document.open).toHaveBeenCalledTimes(1);
    await h.controller.popIn();
    expect(h.adapters.document.close).toHaveBeenCalledTimes(1);
    expect(h.store.getState().active).toBeNull();
  });

  it("without a gesture only the desktop app's window may open", async () => {
    const browser = harness({ desktopApp: false, documentPip: true, videoPip: true });
    expect(await browser.controller.popOut("background")).toBeNull();
    expect(browser.adapters.document.open).not.toHaveBeenCalled();
    const desktop = harness(ALL);
    expect(await desktop.controller.popOut("background")).toBe("tauri");
    // The browser's own auto picture-in-picture grants activation.
    const chrome = harness({ desktopApp: false, documentPip: true, videoPip: true });
    expect(await chrome.controller.popOut("browser")).toBe("document");
  });

  it("does nothing for a ringing call or none, and resolves null when every way fails", async () => {
    const h = harness(ALL, ["tauri", "document", "video"]);
    expect(await h.controller.popOut("user")).toBeNull();
    h.callStore.setState({ call: call("incoming") });
    const ok = harness(ALL);
    ok.callStore.setState({ call: null });
    expect(await ok.controller.popOut("user")).toBeNull();
    expect(ok.adapters.tauri.open).not.toHaveBeenCalled();
  });

  it("in the desktop app, follows the main window's focus and the call's end", async () => {
    const h = harness(ALL);
    const stop = h.controller.start();
    h.focus(false);
    await vi.waitFor(() => expect(h.store.getState().active).toBe("tauri"));
    expect(h.store.getState().reason).toBe("background");
    h.focus(true);
    await vi.waitFor(() => expect(h.store.getState().active).toBeNull());
    expect(h.adapters.tauri.close).toHaveBeenCalledTimes(1);

    h.focus(false);
    await vi.waitFor(() => expect(h.store.getState().active).toBe("tauri"));
    h.callStore.setState({ call: null });
    await vi.waitFor(() => expect(h.store.getState().active).toBeNull());
    expect(h.adapters.tauri.close).toHaveBeenCalledTimes(2);
    stop();
  });

  it("forgets a window the person closed themselves, without closing it again", async () => {
    const h = harness(ALL);
    await h.controller.popOut("user");
    h.adapters.tauri.closedByUser();
    expect(h.store.getState().active).toBeNull();
    await h.controller.popIn();
    expect(h.adapters.tauri.close).not.toHaveBeenCalled();
  });

  it("in a browser, registers for auto picture-in-picture and closes the pop-out on return", async () => {
    const h = harness({ desktopApp: false, documentPip: true, videoPip: true });
    const stop = h.controller.start();
    expect(h.mediaSession.setActionHandler).toHaveBeenCalledWith(
      "enterpictureinpicture",
      expect.any(Function),
    );
    const handler = h.mediaSession.setActionHandler.mock.calls[0]?.[1] as () => void;
    handler();
    await vi.waitFor(() => expect(h.store.getState().active).toBe("document"));
    expect(h.store.getState().reason).toBe("browser");
    h.doc.visibilityState = "visible";
    h.listeners.visibilitychange?.();
    await vi.waitFor(() => expect(h.store.getState().active).toBeNull());
    stop();
    expect(h.mediaSession.setActionHandler).toHaveBeenLastCalledWith("enterpictureinpicture", null);
  });
});
