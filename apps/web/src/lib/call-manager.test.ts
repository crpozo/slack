import type { CallEvent } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./sounds", () => ({
  startRinging: vi.fn(),
  stopRinging: vi.fn(),
}));
import { startRinging, stopRinging } from "./sounds";
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

class FakeDataChannel {
  readyState = "connecting";
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(e: unknown) => void>> = {};
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.listeners.open?.forEach((fn) => fn({}));
  }
  /** A message from the peer. */
  deliver(data: unknown) {
    this.listeners.message?.forEach((fn) => fn({ data: JSON.stringify(data) }));
  }
  /** The notes messages sent so far (media state left out). */
  notes() {
    return this.sent
      .map((d) => JSON.parse(d) as { type?: string })
      .filter((m) => m.type !== undefined);
  }
}

/** The browser's speech recognition (only what `Transcriber` drives). */
class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  processLocally?: boolean;
  running = false;
  track: unknown = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  constructor() {
    FakeRecognition.all.push(this);
  }
  start(track?: unknown) {
    this.running = true;
    this.track = track ?? null;
  }
  stop() {
    this.running = false;
    this.onend?.();
  }
  abort() {
    this.running = false;
  }
  /** One finished phrase. */
  say(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: text } } },
    });
  }
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
  channel: FakeDataChannel | null = null;
  createDataChannel() {
    this.channel = new FakeDataChannel();
    return this.channel;
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
    submitNotes: vi.fn(),
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

describe("AI call notes", () => {
  /** A connected call with its data channel open and speech recognition available. */
  async function notesCall(role: "caller" | "callee" = "caller", speech = true) {
    FakeRecognition.all = [];
    vi.stubGlobal("window", {
      addEventListener() {},
      removeEventListener() {},
      ...(speech ? { webkitSpeechRecognition: FakeRecognition } : {}),
    });
    let h: ReturnType<typeof setup> & { pc: FakePeerConnection };
    if (role === "caller") {
      h = await connectedCall("audio");
    } else {
      const base = setup();
      base.manager.handle(offerFromPeer("audio"));
      await base.manager.accept();
      FakePeerConnection.last.setState("connected");
      h = { ...base, pc: FakePeerConnection.last };
    }
    const channel = h.pc.channel!;
    channel.open();
    const rec = () => FakeRecognition.all.at(-1)!;
    return { ...h, channel, rec, notes: () => useCall.getState().call?.notes };
  }

  it("is off by default, and nothing is submitted for a call without notes", async () => {
    const { manager, deps, notes } = await notesCall();
    expect(notes()).toMatchObject({ on: false, phrases: 0 });
    expect(FakeRecognition.all).toHaveLength(0); // nobody is listening
    manager.hangUp();
    expect(deps.submitNotes).not.toHaveBeenCalled();
  });

  it("switching on tells the peer, listens to your microphone and shares each phrase", async () => {
    const { manager, deps, channel, rec, notes } = await notesCall();
    await manager.toggleNotes();

    expect(channel.notes()).toEqual([{ type: "notes", on: true, at: Date.now() }]);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("AI notes are on"));
    expect(rec().running).toBe(true);
    expect((rec().track as FakeTrack).kind).toBe("audio"); // the call's own microphone
    expect(rec().continuous && rec().interimResults).toBe(true);
    expect(notes()).toMatchObject({ on: true, changedBy: ME, local: { kind: "listening" } });

    rec().say("  hola,   ¿cómo vas?  ");
    expect(channel.notes().at(-1)).toEqual({
      type: "transcript",
      text: "hola, ¿cómo vas?",
      at: Date.now(),
    });
    expect(notes()?.phrases).toBe(1);
  });

  it("the caller submits one merged timeline of both voices on hang-up", async () => {
    const { manager, deps, channel, rec } = await notesCall();
    const connectedAt = Date.now();
    await manager.toggleNotes();
    vi.setSystemTime(connectedAt + 4_000);
    rec().say("Let's ship on Friday.");
    vi.setSystemTime(connectedAt + 9_000);
    channel.deliver({ type: "transcript", text: "I'll write the release notes.", at: Date.now() });
    // A peer clock running ahead can't put a phrase in the future.
    channel.deliver({ type: "transcript", text: "Done.", at: Date.now() + 60_000 });
    vi.setSystemTime(connectedAt + 12_000);
    manager.hangUp();

    expect(deps.submitNotes).toHaveBeenCalledTimes(1);
    expect(deps.submitNotes).toHaveBeenCalledWith({
      callId: expect.any(String),
      channelId: DM,
      startedAt: connectedAt,
      endedAt: connectedAt + 12_000,
      segments: [
        { userId: ME, text: "Let's ship on Friday.", at: connectedAt + 4_000 },
        { userId: PEER, text: "I'll write the release notes.", at: connectedAt + 9_000 },
        { userId: PEER, text: "Done.", at: connectedAt + 9_000 },
      ],
    });
    expect(rec().running).toBe(false);
  });

  it("the peer switching notes on starts your transcription and tells you who did", async () => {
    const { deps, channel, rec, notes } = await notesCall("callee");
    channel.deliver({ type: "notes", on: true, at: Date.now() });
    await vi.waitFor(() => expect(notes()?.on).toBe(true));

    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("bob turned on AI notes"));
    expect(rec().running).toBe(true);
    expect(notes()?.changedBy).toBe(PEER);

    channel.deliver({ type: "notes", on: false, at: Date.now() });
    await vi.waitFor(() => expect(notes()?.on).toBe(false));
    expect(deps.notify).toHaveBeenCalledWith("bob turned off AI notes.");
    expect(rec().running).toBe(false);
  });

  it("the callee never submits", async () => {
    const { manager, deps, channel, rec } = await notesCall("callee");
    channel.deliver({ type: "notes", on: true, at: Date.now() });
    await vi.waitFor(() => expect(rec().running).toBe(true));
    rec().say("hello");
    manager.hangUp();
    expect(deps.submitNotes).not.toHaveBeenCalled();
  });

  it("muting stops the transcription and unmuting resumes it", async () => {
    const { manager, rec, notes } = await notesCall();
    await manager.toggleNotes();
    manager.toggleMic();
    expect(rec().running).toBe(false);
    expect(notes()?.local.kind).toBe("off");
    manager.toggleMic();
    vi.advanceTimersByTime(0);
    expect(rec().running).toBe(true);
  });

  it("phrases while notes are off are not kept, and an older toggle loses to a newer one", async () => {
    const { manager, channel, notes } = await notesCall();
    channel.deliver({ type: "transcript", text: "off the record", at: Date.now() });
    expect(notes()?.phrases).toBe(0);

    vi.setSystemTime(Date.now() + 1_000);
    await manager.toggleNotes(); // on, at t+1s
    channel.deliver({ type: "notes", on: false, at: Date.now() - 500 }); // crossed in flight
    await vi.waitFor(() => expect(notes()?.on).toBe(true));
  });

  it("without speech recognition your side is unavailable, but the peer's voice is kept", async () => {
    const { manager, deps, channel, notes } = await notesCall("caller", false);
    await manager.toggleNotes();
    expect(notes()?.local).toMatchObject({ kind: "unavailable" });
    channel.deliver({ type: "transcript", text: "Hi there", at: Date.now() });
    manager.hangUp();
    expect(deps.submitNotes).toHaveBeenCalledWith(
      expect.objectContaining({ segments: [expect.objectContaining({ userId: PEER })] }),
    );
  });

  it("notes that heard nothing tell the caller instead of submitting an empty transcript", async () => {
    const { manager, deps } = await notesCall();
    await manager.toggleNotes();
    manager.hangUp();
    expect(deps.submitNotes).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Nothing was transcribed"),
    );
  });

  it("can't be switched on before the call connects", async () => {
    const { manager, deps } = setup();
    await manager.startCall(DM, PEER, "audio");
    await manager.toggleNotes();
    expect(useCall.getState().call?.notes.on).toBe(false);
    expect(deps.send.mock.calls.every(([p]) => p.signal !== "notes")).toBe(true);
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

describe("ring sounds follow the call", () => {
  const ring = () => vi.mocked(startRinging);
  const stop = () => vi.mocked(stopRinging);
  beforeEach(() => {
    ring().mockClear();
    stop().mockClear();
  });

  it("the caller rings 'outgoing' once the offer is out and stops when answered", async () => {
    const { manager, deps } = setup();
    await manager.startCall(DM, PEER, "audio");
    expect(ring()).toHaveBeenCalledWith("outgoing");
    const callId = deps.send.mock.calls[0]![0].callId as string;

    stop().mockClear();
    manager.handle({ type: "call.answer", callId, channelId: DM, from: PEER, sdp: "answer-sdp" });
    expect(stop()).toHaveBeenCalled();
  });

  it("stops the outgoing ring on decline, on cancel and when nobody answers", async () => {
    for (const ending of ["declined", "cancelled", "no answer"]) {
      const { manager, deps } = setup();
      await manager.startCall(DM, PEER, "video");
      const callId = deps.send.mock.calls[0]![0].callId as string;
      stop().mockClear();
      if (ending === "declined") {
        manager.handle({
          type: "call.decline",
          callId,
          channelId: DM,
          from: PEER,
          reason: "declined",
        });
      } else if (ending === "cancelled") {
        manager.hangUp();
      } else {
        vi.advanceTimersByTime(45_000);
      }
      expect(stop(), ending).toHaveBeenCalled();
      expect(useCall.getState().call, ending).toBeNull();
    }
  });

  it("the callee rings 'incoming' while the card shows and stops on accept, decline, cancel or timeout", async () => {
    const endings: Array<[string, (m: CallManager) => void | Promise<void>]> = [
      ["accept", (m) => m.accept()],
      ["decline", (m) => m.decline()],
      [
        "caller cancelled",
        (m) =>
          m.handle({
            type: "call.end",
            callId: "call-1",
            channelId: DM,
            from: PEER,
            reason: "cancelled",
          }),
      ],
      ["timeout", () => void vi.advanceTimersByTime(50_000)],
    ];
    for (const [name, end] of endings) {
      const { manager } = setup();
      ring().mockClear();
      manager.handle(offerFromPeer("video"));
      expect(ring(), name).toHaveBeenCalledWith("incoming");
      stop().mockClear();
      await end(manager);
      expect(stop(), name).toHaveBeenCalled();
      manager.hangUp(); // clean up a call that accept() connected
    }
  });

  it("a busy second caller never starts a ring", async () => {
    const { manager } = await connectedCall("audio");
    ring().mockClear();
    manager.handle({
      ...offerFromPeer("audio"),
      callId: "call-2",
      from: "u-carol",
      channelId: "dm_u-alice_u-carol",
    });
    expect(ring()).not.toHaveBeenCalled();
  });
});
