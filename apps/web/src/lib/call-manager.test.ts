import type { CallEvent } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallManager,
  callSummaryText,
  formatCallDuration,
  postsCallSummary,
  useCall,
  type CallDeps,
} from "./call";

// --- Minimal WebRTC / media fakes (Node has none) ----------------------------

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(
    readonly kind: "audio" | "video",
    readonly deviceId: string,
  ) {}
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  addEventListener() {}
}

class FakeStream {
  private readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
}

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  replaceTrack = vi.fn(async (t: FakeTrack | null) => {
    this.track = t;
  });
  setStreams() {}
}

interface FakeTransceiver {
  sender: FakeSender;
  receiver: { track: { kind: string } };
  direction: string;
}

class FakePeerConnection {
  static last: FakePeerConnection;
  connectionState = "new";
  remoteDescription: unknown = null;
  readonly transceivers: FakeTransceiver[] = [];
  private readonly listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor() {
    FakePeerConnection.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  setState(state: string) {
    this.connectionState = state;
    this.listeners.connectionstatechange?.forEach((fn) => fn({}));
  }
  addTransceiver(trackOrKind: FakeTrack | string, init: { direction: string }) {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const t = { sender: new FakeSender(track), receiver: { track: { kind } }, ...init };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    if (this.transceivers.length === 0) {
      // The callee gets these from the remote offer: audio, camera, screen.
      for (const kind of ["audio", "video", "video"]) {
        this.transceivers.push({
          sender: new FakeSender(null),
          receiver: { track: { kind } },
          direction: "recvonly",
        });
      }
    }
    return this.transceivers;
  }
  /** Senders by role, in the negotiated order: audio, camera, screen. */
  sender(role: "audio" | "camera" | "screen") {
    const index = { audio: 0, camera: 1, screen: 2 }[role];
    return this.transceivers[index]!.sender;
  }
  /** Simulates a remote track arriving on the transceiver at `index`. */
  receive(index: number, track: FakeTrack) {
    const transceiver = this.transceivers[index];
    this.listeners.track?.forEach((fn) => fn({ track, transceiver }));
  }
  createOffer = async () => ({ type: "offer", sdp: "offer-sdp" });
  createAnswer = async () => ({ type: "answer", sdp: "answer-sdp" });
  setLocalDescription = async () => {};
  setRemoteDescription = async (d: unknown) => {
    this.remoteDescription = d;
  };
  addIceCandidate = async () => {};
  createDataChannel() {
    return { readyState: "connecting", addEventListener() {}, send() {}, close() {} };
  }
  close() {}
}

// --- Harness ------------------------------------------------------------------

/** Device ids of a stream's tracks (they are `FakeTrack`s). */
const ids = (stream: MediaStream | null | undefined) =>
  stream?.getTracks().map((t) => (t as unknown as FakeTrack).deviceId);

const ME = "u-alice";
const PEER = "u-bob";
const DM = "dm_u-alice_u-bob";
let storage: Record<string, string>;
let getUserMedia: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;

function setup() {
  const deps = {
    send: vi.fn(),
    postMessage: vi.fn(),
    myUserId: () => ME,
    nameOf: (id: string) => id.replace("u-", ""),
    notify: vi.fn(),
  } satisfies CallDeps;
  const manager = new CallManager();
  manager.attach(deps);
  const signals = () => deps.send.mock.calls.map(([p]) => p.signal as string);
  return { manager, deps, signals };
}

const offerFromPeer = (media: "audio" | "video" = "video"): CallEvent => ({
  type: "call.offer",
  callId: "call-1",
  channelId: DM,
  from: PEER,
  media,
  sdp: "offer-sdp",
});

async function connectedCall(media: "audio" | "video" = "video") {
  const h = setup();
  await h.manager.startCall(DM, PEER, media);
  const callId = h.deps.send.mock.calls[0]![0].callId as string;
  h.manager.handle({ type: "call.answer", callId, channelId: DM, from: PEER, sdp: "answer-sdp" });
  await vi.waitFor(() => expect(FakePeerConnection.last.remoteDescription).not.toBeNull());
  FakePeerConnection.last.setState("connected");
  return { ...h, callId, pc: FakePeerConnection.last };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  storage = {};
  getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    const id = (x: unknown, fallback: string) =>
      (x as { deviceId?: { exact?: string } } | undefined)?.deviceId?.exact ?? fallback;
    const tracks: FakeTrack[] = [];
    if (c.audio) tracks.push(new FakeTrack("audio", id(c.audio, "mic-default")));
    if (c.video) tracks.push(new FakeTrack("video", id(c.video, "cam-default")));
    return new FakeStream(tracks);
  });
  getDisplayMedia = vi.fn(async () => new FakeStream([new FakeTrack("video", "screen")]));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => {
      storage[k] = v;
    },
  });
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Tests --------------------------------------------------------------------

describe("call summary text", () => {
  it("formats durations as mm:ss, adding hours past one hour", () => {
    expect(formatCallDuration(0)).toBe("00:00");
    expect(formatCallDuration(5 * 60_000 + 23_000)).toBe("05:23");
    expect(formatCallDuration(12 * 60_000 + 45_400)).toBe("12:45");
    expect(formatCallDuration(3_723_000)).toBe("1:02:03");
    expect(formatCallDuration(-5)).toBe("00:00");
  });

  it("labels voice and video calls", () => {
    expect(callSummaryText("audio", 323_000)).toBe("📞 Call ended • 05:23");
    expect(callSummaryText("video", 765_000)).toBe("📹 Video call ended • 12:45");
  });

  it("is posted by the caller only, and only for calls that connected", () => {
    expect(postsCallSummary("caller", 1)).toBe(true);
    expect(postsCallSummary("callee", 1)).toBe(false);
    expect(postsCallSummary("caller", null)).toBe(false);
  });
});

describe("call duration message", () => {
  it("the caller posts one message when it hangs up", async () => {
    const { manager, deps, signals } = await connectedCall("video");
    vi.setSystemTime(Date.now() + 83_000);
    manager.hangUp();

    expect(signals().at(-1)).toBe("end");
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).toHaveBeenCalledWith(DM, "📹 Video call ended • 01:23");
    manager.hangUp(); // a second click does nothing
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
  });

  it("the caller also posts when the other side hangs up", async () => {
    const { manager, deps, callId } = await connectedCall("audio");
    vi.setSystemTime(Date.now() + 323_000);
    manager.handle({ type: "call.end", callId, channelId: DM, from: PEER, reason: "hangup" });
    manager.handle({ type: "call.end", callId, channelId: DM, from: PEER, reason: "hangup" });

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).toHaveBeenCalledWith(DM, "📞 Call ended • 05:23");
  });

  it("the caller posts when the connection drops for good", async () => {
    const { deps, pc } = await connectedCall("video");
    vi.setSystemTime(Date.now() + 5_000);
    pc.setState("failed");
    expect(deps.postMessage).toHaveBeenCalledWith(DM, "📹 Video call ended • 00:05");
  });

  it("the callee never posts, whoever hangs up", async () => {
    for (const ending of ["callee hangs up", "caller hangs up", "connection fails"]) {
      const { manager, deps } = setup();
      manager.handle(offerFromPeer("video"));
      await manager.accept();
      FakePeerConnection.last.setState("connected");
      vi.setSystemTime(Date.now() + 60_000);
      if (ending === "callee hangs up") manager.hangUp();
      else if (ending === "connection fails") FakePeerConnection.last.setState("failed");
      else {
        manager.handle({
          type: "call.end",
          callId: "call-1",
          channelId: DM,
          from: PEER,
          reason: "hangup",
        });
      }
      expect(deps.postMessage, ending).not.toHaveBeenCalled();
    }
  });

  it("nothing is posted for calls that never connected", async () => {
    const declined = setup();
    await declined.manager.startCall(DM, PEER, "audio");
    const callId = declined.deps.send.mock.calls[0]![0].callId as string;
    declined.manager.handle({
      type: "call.decline",
      callId,
      channelId: DM,
      from: PEER,
      reason: "declined",
    });

    const cancelled = setup();
    await cancelled.manager.startCall(DM, PEER, "video");
    cancelled.manager.hangUp();

    const unanswered = setup();
    await unanswered.manager.startCall(DM, PEER, "video");
    vi.advanceTimersByTime(45_000);

    for (const h of [declined, cancelled, unanswered]) {
      expect(h.deps.postMessage).not.toHaveBeenCalled();
    }
    expect(unanswered.signals().at(-1)).toBe("end");
  });
});

describe("switching devices mid-call", () => {
  it("swaps the microphone with replaceTrack, keeping it muted, without renegotiating", async () => {
    const { manager, signals, pc } = await connectedCall("video");
    const audio = pc.sender("audio");
    const oldMic = audio.track!;
    manager.toggleMic(); // muted

    await manager.switchDevice("audio", "mic-usb");

    expect(audio.replaceTrack).toHaveBeenCalledTimes(1);
    expect(audio.track?.deviceId).toBe("mic-usb");
    expect(audio.track?.enabled).toBe(false);
    expect(oldMic.stopped).toBe(true);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: "mic-usb" } }),
      video: false,
    });
    expect(signals().filter((s) => s === "offer")).toHaveLength(1); // no renegotiation
    expect(JSON.parse(storage["slack.mediaDevices"]!)).toMatchObject({ audioInputId: "mic-usb" });
  });

  it("swaps the camera on its own sender even while the screen is being shared", async () => {
    const { manager, pc } = await connectedCall("video");
    const camera = pc.sender("camera");
    const screen = pc.sender("screen");

    await manager.switchDevice("video", "cam-hd");
    expect(camera.track?.deviceId).toBe("cam-hd");

    await manager.toggleScreenShare();
    expect(screen.track?.deviceId).toBe("screen");
    expect(camera.track?.deviceId).toBe("cam-hd"); // the camera keeps going out

    await manager.switchDevice("video", "cam-wide");
    expect(camera.track?.deviceId).toBe("cam-wide");
    expect(screen.track?.deviceId).toBe("screen");

    await manager.toggleScreenShare(); // stop sharing
    expect(screen.track).toBeNull();
    expect(camera.track?.deviceId).toBe("cam-wide");
  });

  it("with the camera off, only saves the choice for when it is turned back on", async () => {
    const { manager, pc } = await connectedCall("audio");
    getUserMedia.mockClear();

    await manager.switchDevice("video", "cam-hd");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(JSON.parse(storage["slack.mediaDevices"]!)).toMatchObject({ videoInputId: "cam-hd" });

    await manager.toggleCamera();
    expect(pc.sender("camera").track?.deviceId).toBe("cam-hd");
  });

  it("tells the user when the chosen device can't be opened and keeps the old one", async () => {
    const { manager, deps, pc } = await connectedCall("video");
    const before = pc.sender("audio").track;
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));

    await manager.switchDevice("audio", "mic-busy");

    expect(deps.notify).toHaveBeenCalledWith("Your microphone is being used by another app.");
    expect(pc.sender("audio").track).toBe(before);
    expect(before?.stopped).toBe(false);
  });
});

describe("camera and screen as separate tracks", () => {
  it("the caller negotiates audio, camera and screen transceivers", async () => {
    const { pc } = await connectedCall("video");
    expect(pc.transceivers.map((t) => t.receiver.track.kind)).toEqual(["audio", "video", "video"]);
    expect(pc.sender("camera").track?.kind).toBe("video");
    expect(pc.sender("screen").track).toBeNull();
    expect(useCall.getState().call?.canShare).toBe(true);
  });

  it("the callee maps the offer's transceivers back in the same order", async () => {
    const { manager } = setup();
    manager.handle(offerFromPeer("video"));
    await manager.accept();
    const pc = FakePeerConnection.last;

    expect(pc.sender("audio").track?.kind).toBe("audio");
    expect(pc.sender("camera").track?.kind).toBe("video");
    expect(pc.sender("camera").track?.deviceId).toBe("cam-default");
    expect(pc.sender("screen").track).toBeNull();
    expect(pc.transceivers.every((t) => t.direction === "sendrecv")).toBe(true);
  });

  it("sharing the screen keeps the camera on the wire and publishes both previews", async () => {
    const { manager, pc } = await connectedCall("video");
    await manager.toggleScreenShare();

    expect(pc.sender("camera").track?.deviceId).toBe("cam-default");
    expect(pc.sender("screen").track?.deviceId).toBe("screen");
    const view = useCall.getState().call!;
    expect(view.sharing).toBe(true);
    expect(ids(view.localCamera)).toEqual(["cam-default"]);
    expect(ids(view.localScreen)).toEqual(["screen"]);
    expect(pc.sender("camera").replaceTrack).not.toHaveBeenCalled();
  });

  it("turning the camera off while sharing leaves the screen untouched", async () => {
    const { manager, pc } = await connectedCall("video");
    await manager.toggleScreenShare();
    await manager.toggleCamera();

    expect(pc.sender("camera").track).toBeNull();
    expect(pc.sender("screen").track?.deviceId).toBe("screen");
    const view = useCall.getState().call!;
    expect(view.localCamera).toBeNull();
    expect(view.localScreen).not.toBeNull();
  });

  it("routes the peer's screen track apart from their camera and audio", async () => {
    const { pc } = await connectedCall("video");
    pc.receive(0, new FakeTrack("audio", "peer-mic"));
    pc.receive(1, new FakeTrack("video", "peer-cam"));
    pc.receive(2, new FakeTrack("video", "peer-screen"));

    const view = useCall.getState().call!;
    expect(ids(view.remoteStream)).toEqual(["peer-mic", "peer-cam"]);
    expect(ids(view.remoteScreen)).toEqual(["peer-screen"]);
  });

  it("explains that sharing is unavailable when the peer offered no screen transceiver", async () => {
    const { manager, deps } = setup();
    const original = FakePeerConnection.prototype.getTransceivers;
    FakePeerConnection.prototype.getTransceivers = function () {
      // An older client: audio and camera only.
      if (this.transceivers.length === 0) {
        for (const kind of ["audio", "video"]) {
          this.transceivers.push({
            sender: new FakeSender(null),
            receiver: { track: { kind } },
            direction: "recvonly",
          });
        }
      }
      return this.transceivers;
    };
    try {
      manager.handle(offerFromPeer("video"));
      await manager.accept();
      expect(useCall.getState().call?.canShare).toBe(false);
      getDisplayMedia.mockClear();
      await manager.toggleScreenShare();
      expect(getDisplayMedia).not.toHaveBeenCalled();
      expect(deps.notify).toHaveBeenCalledWith("Screen sharing isn't available in this call.");
    } finally {
      FakePeerConnection.prototype.getTransceivers = original;
    }
  });
});
