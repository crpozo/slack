import { MAX_NOTES_CLIP_MS, NOTES_CLIP_MS } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecorderLike } from "./callRecorder";
import {
  CLIP_BITRATE,
  METER_MS,
  MIN_VOICED_MS,
  VoiceClipRecorder,
  type ClipDeps,
  type NotesClip,
} from "./clipRecorder";

/** MediaRecorder: hands its data over asynchronously when stopped, as browsers do. */
class FakeRecorder implements RecorderLike {
  static all: FakeRecorder[] = [];
  state: RecorderLike["state"] = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: unknown,
    readonly options: MediaRecorderOptions,
  ) {
    FakeRecorder.all.push(this);
  }
  get mimeType() {
    return this.options.mimeType ?? "";
  }
  start() {
    this.state = "recording";
  }
  pause() {}
  resume() {}
  stop() {
    this.state = "inactive";
    void Promise.resolve().then(() => {
      this.ondataavailable?.({ data: new Blob(["opus-bytes"], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}

const track = (id: string) => ({ id, kind: "audio" }) as unknown as MediaStreamTrack;

let level: number;
let clips: NotesClip[];
let deps: ClipDeps;
let meterClosed: number;

function make(overrides: Partial<ClipDeps> = {}) {
  const recorder = VoiceClipRecorder.create((c) => clips.push(c), { ...deps, ...overrides });
  if (!recorder) throw new Error("no recorder");
  return recorder;
}

/** `ms` of the call, the voice at `level` meanwhile. */
function speak(ms: number, at = 0.2) {
  level = at;
  vi.advanceTimersByTime(ms);
  level = 0;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  FakeRecorder.all = [];
  clips = [];
  level = 0;
  meterClosed = 0;
  deps = {
    createRecorder: (stream, options) => new FakeRecorder(stream, options),
    supportedType: (type) => type === "audio/webm;codecs=opus",
    createStream: (t) => ({ track: t }) as unknown as MediaStream,
    createMeter: () => ({
      level: () => level,
      close: () => {
        meterClosed++;
      },
    }),
  };
});
afterEach(() => vi.useRealTimers());

describe("VoiceClipRecorder (Phase 43)", () => {
  it("records Opus at 32 kbps while wanted, and hands over a clip with speech when it ends", async () => {
    const recorder = make();
    recorder.setTrack(track("mic"));
    expect(FakeRecorder.all).toHaveLength(0); // not wanted yet
    recorder.setRecording(true);
    expect(FakeRecorder.all[0]!.options).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: CLIP_BITRATE,
    });
    speak(5_000);
    recorder.setRecording(false);
    await vi.waitFor(() => expect(clips).toHaveLength(1));
    expect(clips[0]).toMatchObject({
      mimeType: "audio/webm;codecs=opus",
      startedAt: 1_000_000,
      durationMs: 5_000,
    });
    expect(clips[0]!.blob.size).toBeGreaterThan(0);
  });

  it("drops a clip in which nobody spoke", async () => {
    const recorder = make();
    recorder.setTrack(track("mic"));
    recorder.setRecording(true);
    speak(MIN_VOICED_MS - METER_MS); // a cough
    vi.advanceTimersByTime(60_000);
    await recorder.stop();
    expect(clips).toHaveLength(0);
    expect(meterClosed).toBe(1);
  });

  it("keeps every clip where the level can't be measured", async () => {
    const recorder = make({ createMeter: () => null });
    recorder.setTrack(track("mic"));
    recorder.setRecording(true);
    vi.advanceTimersByTime(3_000);
    await recorder.stop();
    expect(clips).toHaveLength(1);
  });

  it("starts a new file every NOTES_CLIP_MS, so each clip stays small", async () => {
    const recorder = make();
    recorder.setTrack(track("mic"));
    recorder.setRecording(true);
    speak(NOTES_CLIP_MS);
    await vi.waitFor(() => expect(clips).toHaveLength(1));
    expect(FakeRecorder.all).toHaveLength(2); // the next clip already started
    expect(clips[0]!.durationMs).toBe(NOTES_CLIP_MS);
    expect(clips[0]!.durationMs).toBeLessThanOrEqual(MAX_NOTES_CLIP_MS);
    speak(10_000);
    await recorder.stop();
    expect(clips.map((c) => c.startedAt)).toEqual([1_000_000, 1_000_000 + NOTES_CLIP_MS]);
  });

  it("a new microphone closes the clip so far and goes on with the new track", async () => {
    const recorder = make();
    recorder.setTrack(track("mic-1"));
    recorder.setRecording(true);
    speak(4_000);
    const mic2 = track("mic-2");
    recorder.setTrack(mic2);
    await vi.waitFor(() => expect(clips).toHaveLength(1));
    expect(FakeRecorder.all).toHaveLength(2);
    expect((FakeRecorder.all[1]!.stream as { track: MediaStreamTrack }).track.id).toBe("mic-2");
    recorder.setTrack(mic2); // same track: nothing changes
    expect(FakeRecorder.all).toHaveLength(2);
  });

  it("waits for a track; a toggle flicked on and off sends nothing", async () => {
    const recorder = make();
    recorder.setRecording(true);
    expect(FakeRecorder.all).toHaveLength(0);
    recorder.setTrack(track("remote"));
    expect(FakeRecorder.all).toHaveLength(1);
    speak(500, 1);
    recorder.setRecording(false);
    await recorder.stop();
    expect(clips).toHaveLength(0);
  });

  it("stop() resolves once the last clip is handed over; dispose() hands over nothing", async () => {
    const recorder = make();
    recorder.setTrack(track("mic"));
    recorder.setRecording(true);
    speak(3_000);
    const stopped = recorder.stop();
    expect(clips).toHaveLength(0); // the data arrives asynchronously
    await stopped;
    expect(clips).toHaveLength(1);
    recorder.setRecording(true); // after stop: ignored
    expect(FakeRecorder.all).toHaveLength(1);

    const other = make();
    other.setTrack(track("mic"));
    other.setRecording(true);
    speak(3_000);
    other.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(clips).toHaveLength(1);
  });

  it("is unavailable without MediaRecorder or a format Whisper reads", () => {
    expect(VoiceClipRecorder.create(() => {}, null)).toBeNull();
    expect(VoiceClipRecorder.create(() => {}, { ...deps, supportedType: () => false })).toBeNull();
    const safari = VoiceClipRecorder.create(() => {}, {
      ...deps,
      supportedType: (t) => t === "audio/mp4",
    });
    safari?.setTrack(track("mic"));
    safari?.setRecording(true);
    expect(FakeRecorder.all.at(-1)!.options.mimeType).toBe("audio/mp4");
  });
});
