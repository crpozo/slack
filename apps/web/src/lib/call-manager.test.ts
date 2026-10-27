import type { CallEvent } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./sounds", () => ({
  startRinging: vi.fn(),
  stopRinging: vi.fn(),
}));
import { CallRecorder } from "./callRecorder";
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
  iceConnectionState = "new";
  signalingState = "stable";
  remoteDescription: unknown = null;
  localDescription: { type: string; sdp?: string } | null = null;
  /** Every description set, in order (`local:offer`, `remote:answer`, `local:rollback`…). */
  readonly descriptions: string[] = [];
  restartIce = vi.fn();
  private offers = 0;
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
  setIce(state: string) {
    this.iceConnectionState = state;
    this.listeners.iceconnectionstatechange?.forEach((fn) => fn({}));
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
  // The first offer is the call's; later ones are numbered ICE restarts.
  createOffer = vi.fn(async (_options?: unknown) => {
    const n = this.offers++;
    return { type: "offer", sdp: n === 0 ? "offer-sdp" : `restart-offer-${n}` };
  });
  createAnswer = async () => ({ type: "answer", sdp: "answer-sdp" });
  setLocalDescription = vi.fn(async (d: { type: string; sdp?: string }) => {
    this.descriptions.push(`local:${d.type}`);
    if (d.type === "rollback") {
      this.signalingState = "stable";
      return;
    }
    this.localDescription = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
  });
  setRemoteDescription = vi.fn(async (d: { type: string; sdp?: string }) => {
    this.descriptions.push(`remote:${d.type}`);
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  });
  addIceCandidate = vi.fn(async (_candidate?: { usernameFragment?: string }) => {});
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
    // Phase 34: 30 seconds to get it back first.
    expect(deps.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.postMessage).toHaveBeenCalledWith(DM, "📹 Video call ended • 00:35");
  });

  it("the callee never posts, whoever hangs up", async () => {
    for (const ending of ["callee hangs up", "caller hangs up", "connection fails"]) {
      const { manager, deps } = setup();
      manager.handle(offerFromPeer("video"));
      await manager.accept();
      FakePeerConnection.last.setState("connected");
      vi.setSystemTime(Date.now() + 60_000);
      if (ending === "callee hangs up") manager.hangUp();
      else if (ending === "connection fails") {
        FakePeerConnection.last.setState("failed");
        await vi.advanceTimersByTimeAsync(30_000);
      } else {
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

  it("Phase 40: recognizes Spanish (Ecuador) whatever the browser's own language", async () => {
    vi.stubGlobal("navigator", {
      language: "en-US",
      mediaDevices: { getUserMedia, getDisplayMedia },
    });
    const { manager, rec } = await notesCall();
    await manager.toggleNotes();
    expect(rec().lang).toBe("es-EC");
  });

  describe("Phase 40: the call's recording", () => {
    function fakeRecorder() {
      const clip = Promise.resolve({
        blob: new Blob(["x"]),
        mimeType: "audio/webm",
        durationMs: 5,
      });
      const recorder = {
        setSources: vi.fn(),
        setRecording: vi.fn(),
        stop: vi.fn(() => clip),
        dispose: vi.fn(),
      };
      const create = vi
        .spyOn(CallRecorder, "create")
        .mockReturnValue(recorder as unknown as CallRecorder);
      return { recorder, create, clip };
    }
    afterEach(() => vi.restoreAllMocks());

    it("the caller records both voices while notes are on and hands the clip over with the notes", async () => {
      const { recorder, create, clip } = fakeRecorder();
      const h = await notesCall();
      const submitRecording = vi.fn();
      h.manager.attach({ ...h.deps, submitRecording });
      await h.manager.toggleNotes();
      expect(create).toHaveBeenCalledTimes(1);
      expect(recorder.setRecording).toHaveBeenLastCalledWith(true);
      // My microphone is in the mix.
      expect(recorder.setSources.mock.calls.at(-1)![0][0]).toMatchObject({ kind: "audio" });
      expect(h.deps.notify).toHaveBeenCalledWith(expect.stringContaining("The call is recorded"));

      await h.manager.toggleNotes(); // off: paused
      expect(recorder.setRecording).toHaveBeenLastCalledWith(false);
      await h.manager.toggleNotes();
      h.rec().say("Hola.");
      h.manager.hangUp();
      expect(submitRecording).toHaveBeenCalledWith(
        { callId: expect.any(String), channelId: DM },
        clip,
      );
      expect(recorder.dispose).not.toHaveBeenCalled();
    });

    it("the callee never records; a call whose notes aren't sent drops its recording", async () => {
      const callee = fakeRecorder();
      const h = await notesCall("callee");
      h.channel.deliver({ type: "notes", on: true, at: Date.now() });
      await vi.waitFor(() => expect(h.rec().running).toBe(true));
      expect(callee.create).not.toHaveBeenCalled();
      vi.restoreAllMocks();

      const { recorder } = fakeRecorder();
      const caller = await notesCall();
      const submitRecording = vi.fn();
      caller.manager.attach({ ...caller.deps, submitRecording });
      await caller.manager.toggleNotes();
      caller.manager.hangUp(); // nothing transcribed: no notes
      expect(submitRecording).not.toHaveBeenCalled();
      expect(recorder.dispose).toHaveBeenCalled();
    });

    it("tells the caller when the browser can't record (the notes still work)", async () => {
      vi.spyOn(CallRecorder, "create").mockReturnValue(null);
      const { manager, deps } = await notesCall();
      await manager.toggleNotes();
      expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("can't record the call"));
    });
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

describe("reconnecting after a network drop (Phase 34)", () => {
  const sent = (deps: { send: ReturnType<typeof vi.fn> }) =>
    deps.send.mock.calls.map(
      ([p, key]) => ({ ...(p as Record<string, unknown>), key }) as Record<string, unknown>,
    );
  const restarts = (deps: { send: ReturnType<typeof vi.fn> }) =>
    sent(deps).filter((p) => p.signal === "renegotiate");

  async function connectedCallee() {
    const h = setup();
    h.manager.handle(offerFromPeer("video"));
    await h.manager.accept();
    const pc = FakePeerConnection.last;
    pc.setState("connected");
    pc.setIce("connected");
    return { ...h, pc };
  }

  const renegotiate = (
    kind: "offer" | "answer",
    restart: number,
    callId = "call-1",
  ): CallEvent => ({
    type: "call.renegotiate",
    callId,
    channelId: DM,
    from: PEER,
    kind,
    sdp: `${kind}-${restart}`,
    restart,
  });

  it("shows Reconnecting… at once and restarts ICE once the blip outlasts 2 seconds", async () => {
    const { deps, pc, signals } = await connectedCall("video");
    const droppedAt = Date.now();
    pc.setIce("disconnected");

    expect(useCall.getState().call?.reconnecting).toEqual({
      since: droppedAt,
      deadline: droppedAt + 30_000,
    });
    expect(useCall.getState().call?.phase).toBe("connected"); // the timer and notes go on
    await vi.advanceTimersByTimeAsync(1_999);
    expect(pc.restartIce).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
    expect(restarts(deps)).toEqual([
      expect.objectContaining({
        signal: "renegotiate",
        kind: "offer",
        sdp: "restart-offer-1",
        restart: 1,
        to: PEER,
        key: expect.stringMatching(/^call-restart-offer:/),
      }),
    ]);
    expect(signals()).not.toContain("end");
  });

  it("a blip that heals by itself needs no restart", async () => {
    const { pc } = await connectedCall("audio");
    pc.setIce("disconnected");
    await vi.advanceTimersByTimeAsync(1_000);
    pc.setIce("connected");
    expect(useCall.getState().call?.reconnecting).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(useCall.getState().call).not.toBeNull();
  });

  it("applies the answer and clears everything once ICE is back", async () => {
    const { manager, deps, pc, callId, signals } = await connectedCall("video");
    pc.setIce("failed"); // worse than disconnected: restart right away
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts(deps)).toHaveLength(1);

    manager.handle(renegotiate("answer", 1, callId));
    await vi.waitFor(() => expect(pc.descriptions.at(-1)).toBe("remote:answer"));
    pc.setIce("checking");
    pc.setIce("connected");

    expect(useCall.getState().call?.reconnecting).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarts(deps)).toHaveLength(1); // no re-sends, no retries
    expect(signals()).not.toContain("end");
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("re-sends an unanswered offer, then restarts again with fresh candidates", async () => {
    const { deps, pc } = await connectedCall("video");
    pc.setIce("failed");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000); // re-sent
    await vi.advanceTimersByTimeAsync(4_000); // re-sent again
    expect(restarts(deps).map((p) => p.restart)).toEqual([1, 1, 1]);

    await vi.advanceTimersByTimeAsync(2_000); // 8 s: still nothing, a new restart
    expect(pc.descriptions).toContain("local:rollback");
    expect(restarts(deps).at(-1)).toMatchObject({ restart: 2, sdp: "restart-offer-2" });
  });

  it("ends the call 30 seconds after the drop if it never comes back", async () => {
    const { deps, pc, signals } = await connectedCall("video");
    pc.setIce("disconnected");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(useCall.getState().call).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(useCall.getState().call).toBeNull();
    expect(signals().at(-1)).toBe("end");
    expect(sent(deps).at(-1)).toMatchObject({ reason: "failed" });
    expect(deps.notify).toHaveBeenCalledWith(
      "The connection to bob couldn't be restored, so the call ended.",
    );
  });

  it("the callee waits for the caller's offer and answers it, again if re-sent", async () => {
    const { manager, deps, pc } = await connectedCallee();
    pc.setIce("disconnected");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pc.restartIce).not.toHaveBeenCalled(); // the caller drives
    expect(useCall.getState().call?.reconnecting).not.toBeNull();

    manager.handle(renegotiate("offer", 1));
    await vi.waitFor(() => expect(restarts(deps)).toHaveLength(1));
    expect(restarts(deps)[0]).toMatchObject({
      kind: "answer",
      restart: 1,
      sdp: "answer-sdp",
      key: expect.stringMatching(/^call-restart-answer:/),
    });
    expect(pc.descriptions.slice(-2)).toEqual(["remote:offer", "local:answer"]);

    // The answer was lost: the same offer comes again and gets the answer again.
    manager.handle(renegotiate("offer", 1));
    await vi.waitFor(() => expect(restarts(deps)).toHaveLength(2));
    // An older offer arriving late is ignored.
    manager.handle(renegotiate("offer", 2));
    await vi.waitFor(() => expect(restarts(deps)).toHaveLength(3));
    manager.handle(renegotiate("offer", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts(deps)).toHaveLength(3);
  });

  it("both offering at once: the callee rolls its own back, the caller keeps its own", async () => {
    // Callee: its socket came back, so it restarts too, then the caller's offer crosses it.
    const callee = await connectedCallee();
    callee.pc.setIce("disconnected");
    callee.manager.signalingReconnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts(callee.deps)[0]).toMatchObject({ kind: "offer", restart: 1 });
    expect(callee.pc.signalingState).toBe("have-local-offer");
    callee.manager.handle(renegotiate("offer", 1));
    await vi.waitFor(() => expect(restarts(callee.deps)).toHaveLength(2));
    expect(callee.pc.descriptions.slice(-3)).toEqual([
      "local:rollback",
      "remote:offer",
      "local:answer",
    ]);
    expect(restarts(callee.deps)[1]).toMatchObject({ kind: "answer", restart: 1 });

    // Caller: its own offer is out, so the callee's is ignored.
    const caller = await connectedCall("video");
    caller.pc.setIce("failed");
    await vi.advanceTimersByTimeAsync(0);
    caller.manager.handle(renegotiate("offer", 1, caller.callId));
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts(caller.deps).map((p) => p.kind)).toEqual(["offer"]);
    expect(caller.pc.descriptions).not.toContain("remote:offer");
  });

  it("ignores stale answers and offers before the call ever connected", async () => {
    const { manager, pc, callId } = await connectedCall("video");
    pc.setIce("failed");
    await vi.advanceTimersByTimeAsync(0);
    const before = pc.descriptions.length;
    manager.handle(renegotiate("answer", 7, callId)); // not ours
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.descriptions.slice(before)).toEqual([]);
    expect(pc.signalingState).toBe("have-local-offer");

    // Still ringing: there's nothing to restart.
    const ringing = setup();
    ringing.manager.handle(offerFromPeer("audio"));
    ringing.manager.handle(renegotiate("offer", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(ringing.deps.send).not.toHaveBeenCalled();
  });

  it("a reconnected socket re-sends the pending offer at once", async () => {
    const { manager, deps, pc } = await connectedCall("video");
    pc.setIce("failed");
    await vi.advanceTimersByTimeAsync(0);
    manager.signalingReconnected();
    expect(restarts(deps).map((p) => p.restart)).toEqual([1, 1]);
  });

  it("keeps the peer's new candidates until their description arrives", async () => {
    const { manager, pc, callId } = await connectedCall("video");
    pc.setIce("failed");
    await vi.advanceTimersByTimeAsync(0);
    const fresh = { candidate: "candidate:9 1 udp 1 9.9.9.9 9 typ srflx", usernameFragment: "new" };
    pc.addIceCandidate.mockImplementation(async (c) => {
      if (c?.usernameFragment === "new" && pc.signalingState !== "stable") {
        throw new Error("unknown ufrag");
      }
    });
    manager.handle({
      type: "call.ice_candidate",
      callId,
      channelId: DM,
      from: PEER,
      candidate: fresh,
    });
    await vi.advanceTimersByTimeAsync(0);
    manager.handle(renegotiate("answer", 1, callId));
    await vi.waitFor(() =>
      expect(pc.addIceCandidate).toHaveBeenLastCalledWith(expect.objectContaining(fresh)),
    );
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2); // refused once, then added
  });

  it("before the call ever connected, a drop still fails after the grace period", async () => {
    const { manager, deps } = setup();
    await manager.startCall(DM, PEER, "audio");
    const callId = deps.send.mock.calls[0]![0].callId as string;
    manager.handle({ type: "call.answer", callId, channelId: DM, from: PEER, sdp: "answer-sdp" });
    await vi.waitFor(() => expect(FakePeerConnection.last.remoteDescription).not.toBeNull());
    FakePeerConnection.last.setIce("disconnected");
    FakePeerConnection.last.setState("disconnected");
    expect(useCall.getState().call?.reconnecting).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useCall.getState().call).toBeNull();
    expect(FakePeerConnection.last.restartIce).not.toHaveBeenCalled();
  });
});
