import type { CallMedia } from "@mindfultech/shared";
import { calls, useCall, type CallPhase, type CallView } from "./call";
import type { PipAdapter } from "./pip";

// ---------------------------------------------------------------------------
// The desktop app's call window (Phase 24). A Tauri webview is its own
// document: it can't touch the main window's MediaStreams, so the main
// window forwards the peer's video over a local loopback RTCPeerConnection
// (host candidates only, no STUN) signalled with Tauri events, and the small
// window sends its button presses back the same way. Audio stays in the main
// window, which keeps playing in the background.
//
//   main ──call-pip:state──▶ pip      (who, phase, mic/camera flags)
//   main ◀─call-pip:signal─▶ pip      (ready, offer/answer, ICE, bye)
//   main ◀─call-pip:command── pip     (mic, camera, hangup, focus, close)
// ---------------------------------------------------------------------------

export const PIP_LABEL = "call-pip";
export const PIP_PATH = "/call/pip";
export const PIP_SIZE = { width: 320, height: 228 } as const;

export type PipSignal =
  | { kind: "ready" }
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "bye" };

export type PipCommand = "mic" | "camera" | "hangup" | "focus" | "close";

/** What the small window shows besides the video. */
export interface PipCallState {
  name: string;
  media: CallMedia;
  phase: CallPhase;
  connectedAt: number | null;
  micOn: boolean;
  camOn: boolean;
  peerMicOn: boolean;
  peerCamOn: boolean;
  peerSharing: boolean;
  /** AI call notes are on: the small window says so too. */
  notesOn: boolean;
  /** Phase 34: being reconnected until then (epoch ms), `null` while connected. */
  reconnectingUntil: number | null;
}

export function pipStateOf(call: CallView, name: string): PipCallState {
  const connected = call.phase === "connected";
  return {
    name,
    media: call.media,
    phase: call.phase,
    connectedAt: call.connectedAt,
    micOn: call.micOn,
    camOn: call.camOn,
    peerMicOn: connected && call.peer.micOn,
    peerCamOn: connected && call.peer.camOn && !!call.remoteStream,
    peerSharing: connected && call.peer.sharing && !!call.remoteScreen,
    notesOn: call.notes.on,
    reconnectingUntil: call.reconnecting?.deadline ?? null,
  };
}

/** What the main window does with a button pressed in the small one. */
export function runPipCommand(
  command: PipCommand,
  api: Pick<typeof calls, "toggleMic" | "toggleCamera" | "hangUp"> = calls,
  focusMain: () => Promise<void> = focusMainWindow,
  /** Close (Phase 33): the controller's `dismiss`, which closes the window without moving focus. */
  closeWindow: () => Promise<void> | void = () => {},
): Promise<void> | void {
  switch (command) {
    case "mic":
      return api.toggleMic();
    case "camera":
      return api.toggleCamera();
    case "hangup":
      return api.hangUp();
    case "focus":
      return focusMain();
    case "close":
      return closeWindow();
  }
}

// --- Tauri globals (window.__TAURI__, injected by `withGlobalTauri`) ---------------

interface TauriWindowHandle {
  label: string;
  close(): Promise<void>;
  setFocus(): Promise<void>;
  unminimize(): Promise<void>;
  startDragging(): Promise<void>;
  once(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

interface TauriPipGlobal {
  event?: {
    emitTo(target: string, event: string, payload?: unknown): Promise<void>;
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  };
  window?: { getCurrentWindow(): TauriWindowHandle };
  webviewWindow?: {
    WebviewWindow: {
      new (label: string, options: Record<string, unknown>): TauriWindowHandle;
      getByLabel(label: string): Promise<TauriWindowHandle | null>;
    };
  };
}

const tauri = (): TauriPipGlobal | undefined =>
  (window as Window & { __TAURI__?: TauriPipGlobal }).__TAURI__;

const trace = (step: string, detail?: unknown) => console.info("[pip:tauri]", step, detail ?? "");

async function focusMainWindow(): Promise<void> {
  const win = tauri()?.window?.getCurrentWindow();
  if (!win) return;
  await win.unminimize().catch(() => {});
  await win.setFocus();
}

/** Lets the frameless window be dragged by its header (`startDragging` needs a gesture). */
export function dragPipWindow(): void {
  void tauri()
    ?.window?.getCurrentWindow()
    .startDragging()
    .catch(() => {});
}

// --- Main window side --------------------------------------------------------------

/** Opens (or focuses) the native call window; rejects when the app can't create it. */
async function createWindow(): Promise<TauriWindowHandle> {
  const api = tauri()?.webviewWindow;
  if (!api) throw new Error("not in the desktop app");
  const existing = await api.WebviewWindow.getByLabel(PIP_LABEL).catch(() => null);
  if (existing) return existing;
  // Bottom-right of the screen the app is on, clear of the taskbar.
  const x = Math.max(0, (window.screen.availWidth ?? 1280) - PIP_SIZE.width - 24);
  const y = Math.max(0, (window.screen.availHeight ?? 800) - PIP_SIZE.height - 24);
  return new Promise((resolve, reject) => {
    const win = new api.WebviewWindow(PIP_LABEL, {
      url: PIP_PATH,
      title: "Call",
      ...PIP_SIZE,
      minWidth: 240,
      minHeight: 170,
      x,
      y,
      alwaysOnTop: true,
      decorations: false,
      skipTaskbar: true,
      resizable: true,
      focus: false,
      visibleOnAllWorkspaces: true,
    });
    const timer = setTimeout(() => reject(new Error("the call window didn't open")), 8000);
    void win.once("tauri://created", () => {
      clearTimeout(timer);
      resolve(win);
    });
    void win.once("tauri://error", (e) => {
      clearTimeout(timer);
      reject(new Error(String(e.payload)));
    });
  });
}

/**
 * The main window's half of the loopback: one sender for the peer's camera,
 * one for their shared screen, `replaceTrack`ed as the call changes.
 */
class LoopbackSender {
  private pc: RTCPeerConnection | null = null;
  private camera: RTCRtpSender | null = null;
  private screen: RTCRtpSender | null = null;

  constructor(private readonly emit: (signal: PipSignal) => Promise<void>) {}

  async offer(call: CallView | null): Promise<void> {
    this.close();
    const pc = new RTCPeerConnection();
    this.pc = pc;
    this.camera = pc.addTransceiver("video", { direction: "sendonly" }).sender;
    this.screen = pc.addTransceiver("video", { direction: "sendonly" }).sender;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) void this.emit({ kind: "ice", candidate: candidate.toJSON() });
    };
    await this.sync(call);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.emit({ kind: "offer", sdp: offer.sdp ?? "" });
  }

  async handle(signal: PipSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (signal.kind === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    } else if (signal.kind === "ice") {
      await pc.addIceCandidate(signal.candidate).catch((err: unknown) => trace("ice", err));
    }
  }

  /** The current peer tracks onto the senders (no renegotiation needed). */
  async sync(call: CallView | null): Promise<void> {
    const cam = call?.remoteStream?.getVideoTracks()[0] ?? null;
    const screen = call?.remoteScreen?.getVideoTracks()[0] ?? null;
    if (this.camera && this.camera.track !== cam) await this.camera.replaceTrack(cam);
    if (this.screen && this.screen.track !== screen) await this.screen.replaceTrack(screen);
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.camera = null;
    this.screen = null;
  }
}

/**
 * The adapter the pip controller uses in the desktop app: opens the window,
 * streams the call into it, applies its commands, and closes it all.
 */
export function createTauriPipAdapter(
  nameOf: (userId: string) => string,
  /** The small window's Close button: see `PipController.dismiss`. */
  onCloseRequested: () => Promise<void> | void = () => {},
): PipAdapter {
  let win: TauriWindowHandle | null = null;
  let stops: Array<() => void> = [];
  let sender: LoopbackSender | null = null;

  const emitTo = async (event: string, payload: unknown) => {
    await tauri()?.event?.emitTo(PIP_LABEL, event, payload);
  };
  const sendState = (call: CallView | null) =>
    call ? emitTo("call-pip:state", pipStateOf(call, nameOf(call.peerId))) : Promise.resolve();

  async function teardown(): Promise<void> {
    for (const stop of stops) stop();
    stops = [];
    sender?.close();
    sender = null;
    const w = win;
    win = null;
    if (w) {
      await emitTo("call-pip:signal", { kind: "bye" } satisfies PipSignal).catch(() => {});
      await w.close().catch(() => {});
    }
  }

  return {
    async open(onClosed) {
      const events = tauri()?.event;
      if (!events) throw new Error("not in the desktop app");
      win = await createWindow();
      const loop = new LoopbackSender((signal) => emitTo("call-pip:signal", signal));
      sender = loop;
      const unlisten = await Promise.all([
        events.listen<PipSignal>("call-pip:signal", ({ payload }) => {
          if (payload.kind === "ready") {
            // The page is up: stream the call to it and tell it who's calling.
            void loop.offer(useCall.getState().call).catch((err: unknown) => trace("offer", err));
            void sendState(useCall.getState().call);
          } else void loop.handle(payload);
        }),
        events.listen<PipCommand>("call-pip:command", ({ payload }) => {
          void runPipCommand(payload, calls, focusMainWindow, onCloseRequested);
        }),
        win.once("tauri://destroyed", () => {
          win = null;
          void teardown();
          onClosed();
        }),
      ]);
      stops.push(...unlisten);
      stops.push(
        useCall.subscribe((s) => {
          void sendState(s.call);
          void loop.sync(s.call);
        }),
      );
      // Already up (the window was reused): it won't send `ready` again.
      await emitTo("call-pip:signal", { kind: "ready" } satisfies PipSignal).catch(() => {});
      return null;
    },
    close: teardown,
  };
}

// --- The small window's side (`/call/pip`) ---------------------------------------

export interface PipPageHandlers {
  onState(state: PipCallState): void;
  onStreams(streams: { camera: MediaStream | null; screen: MediaStream | null }): void;
  onBye(): void;
}

/**
 * Runs the small window: answers the main window's loopback offer, hands the
 * tracks up as they arrive, relays the call state, and sends commands back.
 */
export function startPipPage(handlers: PipPageHandlers): {
  send(command: PipCommand): void;
  stop(): void;
} {
  const events = tauri()?.event;
  const emit = async (event: string, payload: unknown) => {
    await events?.emitTo("main", event, payload);
  };
  let pc: RTCPeerConnection | null = null;
  const streams = { camera: null as MediaStream | null, screen: null as MediaStream | null };
  const unlisten: Array<() => void> = [];

  async function onSignal(signal: PipSignal): Promise<void> {
    if (signal.kind === "offer") {
      pc?.close();
      pc = new RTCPeerConnection();
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) void emit("call-pip:signal", { kind: "ice", candidate: candidate.toJSON() });
      };
      pc.ontrack = ({ track, transceiver }) => {
        // The first transceiver is the camera, the second the shared screen.
        const stream = new MediaStream([track]);
        if (transceiver.mid === "0") streams.camera = stream;
        else streams.screen = stream;
        handlers.onStreams({ ...streams });
      };
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await emit("call-pip:signal", { kind: "answer", sdp: answer.sdp ?? "" });
    } else if (signal.kind === "ice") {
      await pc?.addIceCandidate(signal.candidate).catch((err: unknown) => trace("ice", err));
    } else if (signal.kind === "bye") {
      handlers.onBye();
    }
  }

  void (async () => {
    if (!events) return;
    unlisten.push(
      await events.listen<PipSignal>("call-pip:signal", ({ payload }) => void onSignal(payload)),
      await events.listen<PipCallState>("call-pip:state", ({ payload }) =>
        handlers.onState(payload),
      ),
    );
    await emit("call-pip:signal", { kind: "ready" } satisfies PipSignal);
  })();

  return {
    send: (command) => void emit("call-pip:command", command),
    stop: () => {
      for (const stop of unlisten) stop();
      pc?.close();
      pc = null;
    },
  };
}
