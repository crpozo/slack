import { create } from "zustand";
import { useCall, type CallView } from "./call";
import { isDesktopApp, watchDesktopFocus } from "./desktop";

// ---------------------------------------------------------------------------
// OS-level picture-in-picture (Phase 24): the call stays visible when the
// person leaves the window (another app, a minimized browser), not just when
// they leave the chat. Four ways, picked at run time by what exists:
//   tauri    – the desktop app opens a small always-on-top native window
//              (no gesture needed: it follows the main window's focus);
//   document – Chromium's Document Picture-in-Picture: our own React UI in a
//              browser-managed floating window (needs a click);
//   video    – HTML5 `requestPictureInPicture()` on the peer's video (a click;
//              Safari too), the browser's controls only;
//   none     – the in-app floating card remains (Firefox).
// ---------------------------------------------------------------------------

export type PipStrategy = "tauri" | "document" | "video";

export interface PipEnv {
  desktopApp: boolean;
  documentPip: boolean;
  videoPip: boolean;
}

export function detectPipEnv(): PipEnv {
  if (typeof window === "undefined")
    return { desktopApp: false, documentPip: false, videoPip: false };
  const w = window as Window & { documentPictureInPicture?: unknown };
  return {
    desktopApp: isDesktopApp(),
    documentPip:
      typeof w.documentPictureInPicture === "object" && w.documentPictureInPicture !== null,
    videoPip:
      typeof document !== "undefined" &&
      "pictureInPictureEnabled" in document &&
      document.pictureInPictureEnabled,
  };
}

/** The strategies this environment offers, best first. */
export function pipStrategies(env: PipEnv): PipStrategy[] {
  const list: PipStrategy[] = [];
  if (env.desktopApp) list.push("tauri");
  if (env.documentPip) list.push("document");
  if (env.videoPip) list.push("video");
  return list;
}

/**
 * Why the call is being popped out:
 *   user       – a click on "Pop out" (a gesture: any strategy);
 *   background – the desktop window lost focus (no gesture: the native window only);
 *   browser    – the browser asked (its auto picture-in-picture, which grants activation).
 */
export type PipReason = "user" | "background" | "browser";

export interface PipState {
  /** The strategy keeping the call visible outside the window right now. */
  active: PipStrategy | null;
  reason: PipReason | null;
  /** The Document Picture-in-Picture window while open (React renders into it). */
  pipWindow: Window | null;
}

export const usePip = create<PipState>(() => ({ active: null, reason: null, pipWindow: null }));

/** Whether the call is shown outside this window (the in-app views show a placeholder). */
export const usePoppedOut = () => usePip((s) => s.active !== null);

/**
 * One way of showing the call outside the window. `open` rejects when it
 * can't (no permission, no frames yet, the browser refused): the next
 * strategy is tried. `onClosed` is how the adapter reports the person closed
 * it from outside (the window's own close button, Esc in the browser's PiP).
 */
export interface PipAdapter {
  open(onClosed: () => void): Promise<Window | null>;
  close(): Promise<void>;
}

export type PipAdapters = Record<PipStrategy, PipAdapter>;

/** `enterpictureinpicture` is newer than TypeScript's DOM lib: the browser may ignore or reject it. */
export interface PipMediaSession {
  setActionHandler(action: string, handler: (() => void) | null): void;
}

/** The part of `document` the controller watches (faked in tests). */
export interface PipDocument {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PipController {
  /** Resolves with the strategy that took the call, or `null` when none could. */
  popOut(reason: PipReason): Promise<PipStrategy | null>;
  popIn(): Promise<void>;
  /** Follows the call and the window: see `createPipController`. Returns a stop function. */
  start(): () => void;
}

/** A call worth showing outside the window: ringing ones aren't. */
export const showsOutside = (call: CallView | null): boolean => !!call && call.phase !== "incoming";

export function createPipController(
  adapters: PipAdapters,
  env: PipEnv,
  deps: {
    store?: typeof usePip;
    callStore?: typeof useCall;
    watchFocus?: (onChange: (focused: boolean) => void) => () => void;
    mediaSession?: PipMediaSession | null;
    doc?: PipDocument | null;
    log?: (step: string, detail?: unknown) => void;
  } = {},
): PipController {
  const store = deps.store ?? usePip;
  const callStore = deps.callStore ?? useCall;
  const log = deps.log ?? ((step, detail) => console.info("[pip]", step, detail ?? ""));
  let opening: Promise<PipStrategy | null> | null = null;

  const closedFromOutside = (strategy: PipStrategy) => {
    if (store.getState().active === strategy) {
      store.setState({ active: null, reason: null, pipWindow: null });
    }
  };

  async function popOut(reason: PipReason): Promise<PipStrategy | null> {
    if (store.getState().active) return store.getState().active;
    if (!showsOutside(callStore.getState().call)) return null;
    if (opening) return opening;
    opening = (async () => {
      for (const strategy of pipStrategies(env)) {
        // Without a gesture only a native window can open.
        if (reason === "background" && strategy !== "tauri") continue;
        try {
          const pipWindow = await adapters[strategy].open(() => closedFromOutside(strategy));
          // The call may have ended while the window was opening.
          if (!showsOutside(callStore.getState().call)) {
            await adapters[strategy].close().catch(() => {});
            return null;
          }
          store.setState({ active: strategy, reason, pipWindow });
          log("popped out", { strategy, reason });
          return strategy;
        } catch (err) {
          log(`${strategy} unavailable`, err);
        }
      }
      return null;
    })().finally(() => (opening = null));
    return opening;
  }

  async function popIn(): Promise<void> {
    const { active } = store.getState();
    if (!active) return;
    store.setState({ active: null, reason: null, pipWindow: null });
    try {
      await adapters[active].close();
    } catch (err) {
      log(`${active} close failed`, err);
    }
  }

  function start(): () => void {
    const stops: Array<() => void> = [];
    // The call ends (or starts ringing): nothing to show outside.
    stops.push(
      callStore.subscribe((s) => {
        if (!showsOutside(s.call) && store.getState().active) void popIn();
      }),
    );
    // Desktop app: the native window follows the main window's focus.
    if (env.desktopApp) {
      const watch = deps.watchFocus ?? watchDesktopFocus;
      stops.push(
        watch((focused) => {
          if (focused) {
            if (store.getState().active === "tauri") void popIn();
          } else if (showsOutside(callStore.getState().call)) {
            void popOut("background");
          }
        }),
      );
    }
    // Browsers: Chromium may pop the call out itself when the tab is left
    // (its auto picture-in-picture, behind a site permission), through this handler.
    const session =
      deps.mediaSession === undefined
        ? ((navigator.mediaSession as unknown as PipMediaSession | undefined) ?? null)
        : deps.mediaSession;
    if (session) {
      try {
        session.setActionHandler("enterpictureinpicture", () => void popOut("browser"));
        stops.push(() => {
          try {
            session.setActionHandler("enterpictureinpicture", null);
          } catch {
            // Already gone.
          }
        });
      } catch {
        // The browser doesn't know this action: fine.
      }
    }
    // Back in the tab, the browser's floating window would just duplicate the call.
    const doc = deps.doc === undefined ? document : deps.doc;
    if (doc) {
      const onVisible = () => {
        const { active } = store.getState();
        if (doc.visibilityState === "visible" && (active === "document" || active === "video")) {
          void popIn();
        }
      };
      doc.addEventListener("visibilitychange", onVisible);
      stops.push(() => doc.removeEventListener("visibilitychange", onVisible));
    }
    return () => {
      for (const stop of stops) stop();
      void popIn();
    };
  }

  return { popOut, popIn, start };
}

// --- The browser adapters ----------------------------------------------------------

let pipVideo: HTMLVideoElement | null = null;
/** The `<video>` of the peer that HTML5 picture-in-picture would show (`CallLayer` keeps one). */
export function registerPipVideo(el: HTMLVideoElement | null): void {
  pipVideo = el;
}

export const videoPipAdapter: PipAdapter = {
  async open(onClosed) {
    const el = pipVideo;
    if (!el) throw new Error("no video to show");
    await el.requestPictureInPicture();
    el.addEventListener("leavepictureinpicture", onClosed, { once: true });
    return null;
  },
  async close() {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
  },
};

interface DocumentPipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

/** Copies the page's styles and theme into the picture-in-picture document. */
export function adoptStyles(from: Document, into: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = into.createElement("style");
      style.textContent = css;
      into.head.appendChild(style);
    } catch {
      // Cross-origin sheet (a font service): link it instead.
      const href = sheet.href;
      if (!href) continue;
      const link = into.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      into.head.appendChild(link);
    }
  }
  const sizing = into.createElement("style");
  sizing.textContent =
    "html, body { height: 100%; margin: 0; background: #0E0D12; overflow: hidden; }";
  into.head.appendChild(sizing);
  into.documentElement.className = from.documentElement.className;
}

let docPipWindow: Window | null = null;

export const documentPipAdapter: PipAdapter = {
  async open(onClosed) {
    const api = (window as Window & { documentPictureInPicture?: DocumentPipApi })
      .documentPictureInPicture;
    if (!api) throw new Error("no Document Picture-in-Picture");
    const pipWindow = await api.requestWindow({ width: 360, height: 260 });
    adoptStyles(document, pipWindow.document);
    pipWindow.addEventListener("pagehide", () => {
      if (docPipWindow === pipWindow) docPipWindow = null;
      onClosed();
    });
    docPipWindow = pipWindow;
    return pipWindow;
  },
  async close() {
    const w = docPipWindow;
    docPipWindow = null;
    w?.close();
  },
};
