import type { CallEvent } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
vi.mock("./sounds", () => ({
  startRinging: vi.fn(),
  stopRinging: vi.fn(),
}));
import { CallRecorder } from "./callRecorder";
import { VoiceClipRecorder, type NotesClip } from "./clipRecorder";
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
  type FakeClips = {
    onClip: (clip: NotesClip) => void;
    setTrack: ReturnType<typeof vi.fn>;
    setRecording: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  /** Phase 43: each voice's clip recorder, in the order made (mine, then theirs). */
  let clips: FakeClips[];
  let clipsCreate: MockInstance<typeof VoiceClipRecorder.create>;
  let backup: {
    setSources: ReturnType<typeof vi.fn>;
    setRecording: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  let backupCreate: MockInstance<typeof CallRecorder.create>;
  const recording = Promise.resolve({
    blob: new Blob(["x"]),
    mimeType: "audio/webm",
    durationMs: 5,
  });
  const clip = (startedAt: number): NotesClip => ({
    blob: new Blob(["opus"], { type: "audio/webm" }),
    mimeType: "audio/webm",
    startedAt,
    durationMs: 240_000,
  });

  beforeEach(() => {
    clips = [];
    clipsCreate = vi.spyOn(VoiceClipRecorder, "create").mockImplementation((onClip) => {
      const fake: FakeClips = {
        onClip,
        setTrack: vi.fn(),
        setRecording: vi.fn(),
        stop: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      clips.push(fake);
      return fake as unknown as VoiceClipRecorder;
    });
    backup = {
      setSources: vi.fn(),
      setRecording: vi.fn(),
      stop: vi.fn(() => recording),
      dispose: vi.fn(),
    };
    backupCreate = vi
      .spyOn(CallRecorder, "create")
      .mockReturnValue(backup as unknown as CallRecorder);
  });
  afterEach(() => vi.restoreAllMocks());

  /** A connected call with its data channel open. */
  async function notesCall(role: "caller" | "callee" = "caller") {
    let h: ReturnType<typeof setup> & { pc: FakePeerConnection; callId: string };
    if (role === "caller") {
      h = await connectedCall("audio");
    } else {
      const base = setup();
      base.manager.handle(offerFromPeer("audio"));
      await base.manager.accept();
      FakePeerConnection.last.setState("connected");
      h = { ...base, pc: FakePeerConnection.last, callId: "call-1" };
    }
    const channel = h.pc.channel!;
    channel.open();
    const uploadNotesClip = vi.fn();
    const submitRecording = vi.fn();
    h.manager.attach({ ...h.deps, uploadNotesClip, submitRecording });
    return {
      ...h,
      channel,
      uploadNotesClip,
      submitRecording,
      notes: () => useCall.getState().call?.notes,
    };
  }

  it("is off by default, records nothing, and nothing is submitted for a call without notes", async () => {
    const { manager, deps, notes } = await notesCall();
    expect(notes()).toEqual({ on: false, changedBy: null, keepAudio: false, unavailable: null });
    expect(clipsCreate).not.toHaveBeenCalled();
    expect(backupCreate).not.toHaveBeenCalled();
    manager.hangUp();
    expect(deps.submitNotes).not.toHaveBeenCalled();
  });

  it("switching on tells the peer and records each voice in clips for Whisper", async () => {
    const { manager, deps, channel, pc, notes } = await notesCall();
    await manager.toggleNotes();

    expect(channel.notes()).toEqual([{ type: "notes", on: true, at: Date.now() }]);
    expect(deps.notify).toHaveBeenCalledWith(
      expect.stringContaining("sent to OpenAI for transcription and then discarded"),
    );
    expect(notes()).toMatchObject({ on: true, changedBy: ME, keepAudio: false });
    expect(clips).toHaveLength(2);
    const [mine, theirs] = clips;
    expect(mine!.setTrack.mock.calls.at(-1)![0]).toMatchObject({ kind: "audio" }); // my microphone
    expect(mine!.setRecording).toHaveBeenLastCalledWith(true);
    expect(theirs!.setRecording).toHaveBeenLastCalledWith(true);

    // The other side's voice is its own recording, from the moment it arrives.
    const remote = new FakeTrack("audio", "peer-mic");
    pc.receive(0, remote);
    expect(theirs!.setTrack).toHaveBeenLastCalledWith(remote);

    // Off: both stop (each clip ends where notes went off).
    await manager.toggleNotes();
    expect(mine!.setRecording).toHaveBeenLastCalledWith(false);
    expect(theirs!.setRecording).toHaveBeenLastCalledWith(false);
  });

  it("sends each clip as it ends, tagged with whose voice it is", async () => {
    const { manager, callId, uploadNotesClip } = await notesCall();
    await manager.toggleNotes();
    const [mine, theirs] = clips;
    mine!.onClip(clip(1));
    theirs!.onClip(clip(2));
    expect(uploadNotesClip.mock.calls).toEqual([
      [
        { callId, channelId: DM },
        { ...clip(1), speaker: ME },
      ],
      [
        { callId, channelId: DM },
        { ...clip(2), speaker: PEER },
      ],
    ]);
  });

  it("on hang-up the caller asks for the notes once the last clips are handed over", async () => {
    const { manager, deps, callId, uploadNotesClip, submitRecording } = await notesCall();
    const connectedAt = Date.now();
    await manager.toggleNotes();
    const [mine, theirs] = clips;
    // The clip in progress is handed over as the recorder stops, after the call.
    mine!.stop.mockImplementation(async () => mine!.onClip(clip(connectedAt + 1)));
    vi.setSystemTime(connectedAt + 12_000);
    manager.hangUp();

    expect(deps.submitNotes).toHaveBeenCalledTimes(1);
    const [input, ready] = deps.submitNotes.mock.calls[0]!;
    expect(input).toEqual({
      callId,
      channelId: DM,
      startedAt: connectedAt,
      endedAt: connectedAt + 12_000,
      source: "whisper",
      keepAudio: false,
    });
    expect(input).not.toHaveProperty("segments");
    await ready;
    expect(mine!.stop).toHaveBeenCalled();
    expect(theirs!.stop).toHaveBeenCalled();
    expect(uploadNotesClip).toHaveBeenCalledWith(
      { callId, channelId: DM },
      expect.objectContaining({ speaker: ME, startedAt: connectedAt + 1 }),
    );
    // No one asked to keep the audio: it was never recorded, nothing is uploaded.
    expect(backupCreate).not.toHaveBeenCalled();
    expect(submitRecording).not.toHaveBeenCalled();
  });

  it("the peer switching notes on tells you who did; the callee records nothing and never submits", async () => {
    const { manager, deps, channel, notes } = await notesCall("callee");
    channel.deliver({ type: "notes", on: true, at: Date.now() });
    await vi.waitFor(() => expect(notes()?.on).toBe(true));
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("bob turned on AI notes"));
    expect(notes()?.changedBy).toBe(PEER);
    expect(clipsCreate).not.toHaveBeenCalled();

    channel.deliver({ type: "notes", on: false, at: Date.now() });
    await vi.waitFor(() => expect(notes()?.on).toBe(false));
    expect(deps.notify).toHaveBeenCalledWith("bob turned off AI notes.");
    manager.hangUp();
    expect(deps.submitNotes).not.toHaveBeenCalled();
  });

  it("muting stops recording your voice (not theirs), unmuting resumes it", async () => {
    const { manager } = await notesCall();
    await manager.toggleNotes();
    const [mine, theirs] = clips;
    manager.toggleMic();
    expect(mine!.setRecording).toHaveBeenLastCalledWith(false);
    expect(theirs!.setRecording).toHaveBeenLastCalledWith(true);
    manager.toggleMic();
    expect(mine!.setRecording).toHaveBeenLastCalledWith(true);
  });

  it("an older toggle loses to a newer one; phrases from older apps are left out", async () => {
    const { manager, deps, channel, notes } = await notesCall();
    vi.setSystemTime(Date.now() + 1_000);
    await manager.toggleNotes(); // on, at t+1s
    channel.deliver({ type: "notes", on: false, at: Date.now() - 500 }); // crossed in flight
    channel.deliver({ type: "transcript", text: "hola", at: Date.now() });
    await vi.waitFor(() => expect(notes()?.on).toBe(true));
    manager.hangUp();
    expect(deps.submitNotes.mock.calls[0]![0]).not.toHaveProperty("segments");
  });

  it("tells the caller when the browser can't record: no notes for that call", async () => {
    clipsCreate.mockReturnValue(null);
    const { manager, deps, notes } = await notesCall();
    await manager.toggleNotes();
    expect(notes()?.unavailable).toContain("can't record the call");
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("can't record the call"));
    manager.hangUp();
    expect(deps.submitNotes).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenLastCalledWith(expect.stringContaining("wasn't recorded"));
  });

  it("can't be switched on before the call connects", async () => {
    const { manager, deps } = setup();
    await manager.startCall(DM, PEER, "audio");
    await manager.toggleNotes();
    manager.toggleKeepAudio();
    expect(useCall.getState().call?.notes).toMatchObject({ on: false, keepAudio: false });
    expect(deps.send.mock.calls.every(([p]) => p.signal !== "notes")).toBe(true);
  });

  describe("Phase 43: Guardar audio original como respaldo", () => {
    it("keeping the audio tells the peer, records the mixed call and hands it over with the notes", async () => {
      const { manager, deps, channel, notes, submitRecording, callId } = await notesCall();
      await manager.toggleNotes();
      manager.toggleKeepAudio();
      expect(channel.notes().at(-1)).toEqual({ type: "backup", keep: true, at: Date.now() });
      expect(deps.notify).toHaveBeenCalledWith("The original audio will be saved with the notes.");
      expect(notes()?.keepAudio).toBe(true);
      expect(backupCreate).toHaveBeenCalledTimes(1);
      expect(backup.setRecording).toHaveBeenLastCalledWith(true);
      expect(backup.setSources.mock.calls.at(-1)![0][0]).toMatchObject({ kind: "audio" });

      manager.hangUp();
      expect(deps.submitNotes.mock.calls[0]![0]).toMatchObject({ keepAudio: true });
      expect(submitRecording).toHaveBeenCalledWith({ callId, channelId: DM }, recording);
      expect(backup.dispose).not.toHaveBeenCalled();
    });

    it("switching it back off drops what was recorded at once", async () => {
      const { manager, deps, submitRecording } = await notesCall();
      await manager.toggleNotes();
      manager.toggleKeepAudio();
      manager.toggleKeepAudio();
      expect(backup.dispose).toHaveBeenCalled();
      expect(deps.notify).toHaveBeenLastCalledWith("The original audio won't be saved.");
      manager.hangUp();
      expect(deps.submitNotes.mock.calls[0]![0]).toMatchObject({ keepAudio: false });
      expect(submitRecording).not.toHaveBeenCalled();
    });

    it("the peer's choice applies to the caller's recording; the newer of two crossing choices wins", async () => {
      const { manager, deps, channel, notes } = await notesCall();
      await manager.toggleNotes();
      channel.deliver({ type: "backup", keep: true, at: Date.now() });
      expect(deps.notify).toHaveBeenCalledWith(
        "bob chose to save the original audio with the notes.",
      );
      expect(notes()?.keepAudio).toBe(true);
      expect(backupCreate).toHaveBeenCalledTimes(1);
      channel.deliver({ type: "backup", keep: false, at: Date.now() - 1_000 }); // older
      expect(notes()?.keepAudio).toBe(true);
    });

    it("the callee can choose it too, and never records", async () => {
      const { manager, channel, notes } = await notesCall("callee");
      channel.deliver({ type: "notes", on: true, at: Date.now() });
      await vi.waitFor(() => expect(notes()?.on).toBe(true));
      manager.toggleKeepAudio();
      expect(channel.notes().at(-1)).toMatchObject({ type: "backup", keep: true });
      expect(backupCreate).not.toHaveBeenCalled();
    });
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

  it("shares a screen captured in the desktop call window, never stopping its capture", async () => {
    const { manager, pc } = await connectedCall("video");
    pc.channel!.open();
    const fromWindow = new FakeTrack("video", "window-screen");
    await manager.shareScreenTrack(fromWindow as unknown as MediaStreamTrack);
    expect(pc.sender("screen").track).toBe(fromWindow);
    expect(useCall.getState().call?.sharing).toBe(true);
    expect(pc.channel!.sent.map((d) => JSON.parse(d) as { sharing?: boolean }).at(-1)).toEqual(
      expect.objectContaining({ sharing: true }),
    );

    await manager.stopSharing();
    expect(pc.sender("screen").track).toBeNull();
    expect(useCall.getState().call?.sharing).toBe(false);
    expect(fromWindow.stopped).toBe(false); // the small window stops its own capture

    // Sharing from the main window again is ours to stop.
    await manager.toggleScreenShare();
    const own = pc.sender("screen").track!;
    await manager.stopSharing();
    expect(own.stopped).toBe(true);
  });

  it("a capture from the call window replaces the screen being shared", async () => {
    const { manager, pc } = await connectedCall("video");
    await manager.toggleScreenShare();
    const own = pc.sender("screen").track!;
    const fromWindow = new FakeTrack("video", "window-screen");
    await manager.shareScreenTrack(fromWindow as unknown as MediaStreamTrack);
    expect(own.stopped).toBe(true);
    expect(pc.sender("screen").track).toBe(fromWindow);
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
