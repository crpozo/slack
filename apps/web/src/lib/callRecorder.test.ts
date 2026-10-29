import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallRecorder,
  RECORDING_BITRATE,
  recordingExtension,
  type MixerLike,
  type RecorderDeps,
  type RecorderLike,
} from "./callRecorder";

class FakeRecorder implements RecorderLike {
  state: RecorderLike["state"] = "inactive";
  ondataavailable: RecorderLike["ondataavailable"] = null;
  onstop: RecorderLike["onstop"] = null;
  calls: string[] = [];
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
    readonly mimeType = options.mimeType ?? "",
  ) {}
  start(timeslice?: number) {
    this.calls.push(`start:${timeslice}`);
    this.state = "recording";
  }
  pause() {
    this.calls.push("pause");
    this.state = "paused";
  }
  resume() {
    this.calls.push("resume");
    this.state = "recording";
  }
  stop() {
    this.calls.push("stop");
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["opus-bytes"], { type: this.mimeType }) });
    queueMicrotask(() => this.onstop?.());
  }
}

const track = (id: string, kind = "audio") => ({ id, kind }) as unknown as MediaStreamTrack;

function setup(supported = ["audio/webm;codecs=opus"]) {
  let now = 1_000;
  const connected: string[] = [];
  const disconnected: string[] = [];
  let recorder: FakeRecorder | null = null;
  const mixer: MixerLike & { closed: boolean } = {
    state: "running",
    closed: false,
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {
      mixer.closed = true;
    }),
    createMediaStreamDestination: () => ({ stream: { id: "mixed" } as unknown as MediaStream }),
    createMediaStreamSource: (stream: MediaStream) => {
      const id = (stream as unknown as { tracks: MediaStreamTrack[] }).tracks[0]!.id;
      return {
        connect: () => connected.push(id),
        disconnect: () => disconnected.push(id),
      };
    },
  };
  const deps: RecorderDeps = {
    createMixer: () => mixer,
    createRecorder: (stream, options) => (recorder = new FakeRecorder(stream, options)),
    supportedType: (type) => supported.includes(type),
    now: () => now,
  };
  return {
    deps,
    mixer,
    connected,
    disconnected,
    recorder: () => recorder!,
    advance: (ms: number) => (now += ms),
  };
}

describe("CallRecorder (Phase 40)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: MediaStreamTrack[]) {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("isn't available without MediaRecorder or a supported audio type", () => {
    expect(CallRecorder.create(null)).toBeNull();
    expect(CallRecorder.create(setup([]).deps)).toBeNull();
  });

  it("records Opus at 32 kbps from the mixed stream, preferring WebM, else MP4 (Safari)", () => {
    const t = setup(["audio/webm;codecs=opus", "audio/mp4"]);
    CallRecorder.create(t.deps);
    expect(t.recorder().options).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: RECORDING_BITRATE,
    });
    const safari = setup(["audio/mp4"]);
    CallRecorder.create(safari.deps);
    expect(safari.recorder().options.mimeType).toBe("audio/mp4");
    expect(recordingExtension("audio/mp4")).toBe("m4a");
    expect(recordingExtension("audio/webm;codecs=opus")).toBe("webm");
  });

  it("mixes both voices, following a new microphone and ignoring video", () => {
    const t = setup();
    const rec = CallRecorder.create(t.deps)!;
    const mic = track("mic");
    const theirs = track("theirs");
    rec.setSources([mic, theirs, track("camera", "video"), null]);
    expect(t.connected).toEqual(["mic", "theirs"]);
    // A new microphone: the old one leaves the mix, the other voice stays.
    rec.setSources([track("mic2"), theirs]);
    expect(t.disconnected).toEqual(["mic"]);
    expect(t.connected).toEqual(["mic", "theirs", "mic2"]);
  });

  it("records only while notes are on, and the clip lasts that long", async () => {
    const t = setup();
    const rec = CallRecorder.create(t.deps)!;
    rec.setRecording(false); // nothing to pause yet
    rec.setRecording(true);
    t.advance(60_000);
    rec.setRecording(false);
    t.advance(30_000); // notes off: not recorded
    rec.setRecording(true);
    t.advance(15_000);
    expect(t.recorder().calls).toEqual(["start:10000", "pause", "resume"]);
    const clip = await rec.stop();
    expect(clip).not.toBeNull();
    expect(clip!.durationMs).toBe(75_000);
    expect(clip!.mimeType).toBe("audio/webm;codecs=opus");
    expect(await clip!.blob.text()).toBe("opus-bytes");
    expect(t.mixer.closed).toBe(true);
    // Stopping twice gives the same clip; nothing records after.
    expect(await rec.stop()).toBe(clip);
    rec.setRecording(true);
    expect(t.recorder().calls.at(-1)).toBe("stop");
  });

  it("gives no clip when notes never ran, and drops it when the notes aren't sent", async () => {
    const t = setup();
    expect(await CallRecorder.create(t.deps)!.stop()).toBeNull();
    const u = setup();
    const rec = CallRecorder.create(u.deps)!;
    rec.setSources([track("mic")]);
    rec.setRecording(true);
    rec.dispose();
    expect(u.recorder().calls).toEqual(["start:10000", "stop"]);
    expect(u.disconnected).toEqual(["mic"]);
    expect(await rec.stop()).toBeNull();
  });

  it("wakes a suspended audio context (notes turned on from the other side)", () => {
    const t = setup();
    t.mixer.state = "suspended";
    CallRecorder.create(t.deps)!.setRecording(true);
    expect(t.mixer.resume).toHaveBeenCalled();
  });
});
