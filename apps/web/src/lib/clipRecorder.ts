import { MAX_NOTES_CLIP_MS, NOTES_CLIP_MS } from "@mindfultech/shared";
import type { RecorderLike } from "./callRecorder";

// ---------------------------------------------------------------------------
// Phase 43: the call's audio for OpenAI Whisper. While AI notes are on, the
// caller's app records each voice on its own (its microphone, the other
// side's audio), so the transcript knows who said what, in clips of
// `NOTES_CLIP_MS`. Each clip is a complete file (a new MediaRecorder per
// clip), handed over as it ends and sent for transcription at once. A clip
// in which nobody spoke (a level meter on the track says so) is dropped
// here: silence would only cost money and make Whisper invent words.
// ---------------------------------------------------------------------------

export interface NotesClip {
  blob: Blob;
  mimeType: string;
  /** When the clip started (epoch ms). */
  startedAt: number;
  durationMs: number;
}

/** How loud a track is right now, 0 (silence) to 1. */
export interface VoiceMeter {
  level(): number;
  close(): void;
}

export interface ClipDeps {
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => RecorderLike;
  supportedType: (type: string) => boolean;
  createStream: (track: MediaStreamTrack) => MediaStream;
  /** `null` where the level can't be measured: every clip is then kept. */
  createMeter: (stream: MediaStream) => VoiceMeter | null;
  now?: () => number;
}

/** Bits per second: plenty for speech; a 4-minute clip is about 1 MB. */
export const CLIP_BITRATE = 32_000;
/** Formats Whisper reads, in order of preference (Chrome, Firefox, Safari). */
const CLIP_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
/** How often the level is sampled. */
export const METER_MS = 200;
/** RMS above this (about -40 dBFS) is someone speaking, not room noise. */
export const VOICE_LEVEL = 0.01;
/** A clip with less speech than this isn't worth transcribing. */
export const MIN_VOICED_MS = 800;
/** Shorter clips (a toggle flicked on and off) aren't sent. */
const MIN_CLIP_MS = 1_000;

function browserMeter(stream: MediaStream): VoiceMeter | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      level() {
        // A context the browser keeps suspended (autoplay policy) hears nothing:
        // count it as speech rather than drop clips that may have some.
        if (context.state !== "running") {
          void context.resume().catch(() => {});
          return 1;
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        return Math.sqrt(sum / samples.length);
      },
      close() {
        source.disconnect();
        void context.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

function browserDeps(): ClipDeps | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  return {
    createRecorder: (stream, options) => new MediaRecorder(stream, options) as RecorderLike,
    supportedType: (type) => MediaRecorder.isTypeSupported(type),
    createStream: (track) => new MediaStream([track]),
    createMeter: browserMeter,
  };
}

interface Clip {
  recorder: RecorderLike;
  chunks: Blob[];
  startedAt: number;
  voicedMs: number;
  rotate: ReturnType<typeof setTimeout>;
}

/** One voice of the call, recorded in clips while wanted. */
export class VoiceClipRecorder {
  private readonly now: () => number;
  private track: MediaStreamTrack | null = null;
  private stream: MediaStream | null = null;
  private meter: VoiceMeter | null = null;
  private meterTimer: ReturnType<typeof setInterval> | undefined;
  private clip: Clip | null = null;
  private wanted = false;
  private closed = false;
  /** Clips stopping (MediaRecorder hands the data over asynchronously). */
  private readonly ending = new Set<Promise<void>>();

  /** `null` where the browser can't record audio in a format Whisper reads. */
  static create(
    onClip: (clip: NotesClip) => void,
    deps: ClipDeps | null = browserDeps(),
  ): VoiceClipRecorder | null {
    if (!deps) return null;
    const mimeType = CLIP_TYPES.find((t) => deps.supportedType(t));
    return mimeType ? new VoiceClipRecorder(deps, mimeType, onClip) : null;
  }

  private constructor(
    private readonly deps: ClipDeps,
    private readonly mimeType: string,
    private readonly onClip: (clip: NotesClip) => void,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** The voice to record (a new microphone, the other side's track arriving). */
  setTrack(track: MediaStreamTrack | null | undefined): void {
    const next = track && track.kind === "audio" ? track : null;
    if (this.closed || next === this.track) return;
    this.endClip(); // what was heard so far goes out as its own clip
    this.meter?.close();
    this.track = next;
    this.stream = next ? this.deps.createStream(next) : null;
    this.meter = this.stream ? this.deps.createMeter(this.stream) : null;
    this.sync();
  }

  /** Records while `on` (notes on, call connected, not muted); a clip ends when it goes off. */
  setRecording(on: boolean): void {
    if (this.closed) return;
    this.wanted = on;
    this.sync();
  }

  /** The call ended: the last clip is handed over, then this resolves. */
  async stop(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.endClip();
      this.release();
    }
    await Promise.all([...this.ending]);
  }

  /** The call ended without notes: nothing more is handed over. */
  dispose(): void {
    this.closed = true;
    const clip = this.clip;
    this.clip = null;
    if (clip) {
      clearTimeout(clip.rotate);
      clip.recorder.ondataavailable = null;
      clip.recorder.onstop = null;
      try {
        clip.recorder.stop();
      } catch {
        // already stopped
      }
    }
    this.release();
  }

  private sync(): void {
    const recording = this.wanted && !!this.stream && !this.closed;
    if (recording && !this.clip) this.startClip();
    else if (!recording) this.endClip();
    if (recording && this.meter && this.meterTimer === undefined) {
      this.meterTimer = setInterval(() => this.sample(), METER_MS);
    } else if (!recording && this.meterTimer !== undefined) {
      clearInterval(this.meterTimer);
      this.meterTimer = undefined;
    }
  }

  private sample(): void {
    if (this.clip && this.meter && this.meter.level() > VOICE_LEVEL) this.clip.voicedMs += METER_MS;
  }

  private startClip(): void {
    if (!this.stream) return;
    let recorder: RecorderLike;
    try {
      recorder = this.deps.createRecorder(this.stream, {
        mimeType: this.mimeType,
        audioBitsPerSecond: CLIP_BITRATE,
      });
      recorder.start();
    } catch {
      return; // the track ended under us; the next change tries again
    }
    const clip: Clip = {
      recorder,
      chunks: [],
      startedAt: this.now(),
      voicedMs: 0,
      rotate: setTimeout(() => {
        this.endClip();
        this.sync();
      }, NOTES_CLIP_MS),
    };
    recorder.ondataavailable = ({ data }) => {
      if (data.size > 0) clip.chunks.push(data);
    };
    this.clip = clip;
  }

  private endClip(): void {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    clearTimeout(clip.rotate);
    const endedAt = this.now();
    // Decided now: the meter may be released before the data arrives.
    const voiced = !this.meter || clip.voicedMs >= MIN_VOICED_MS;
    const ending = new Promise<void>((resolve) => {
      const finish = () => {
        clip.recorder.onstop = null;
        const blob = new Blob(clip.chunks, { type: clip.recorder.mimeType || this.mimeType });
        const durationMs = Math.min(endedAt - clip.startedAt, MAX_NOTES_CLIP_MS);
        if (blob.size > 0 && durationMs >= MIN_CLIP_MS && voiced) {
          this.onClip({ blob, mimeType: blob.type, startedAt: clip.startedAt, durationMs });
        }
        resolve();
      };
      if (clip.recorder.state === "inactive") {
        finish();
        return;
      }
      clip.recorder.onstop = finish;
      try {
        clip.recorder.stop();
      } catch {
        finish();
      }
    });
    this.ending.add(ending);
    void ending.then(() => this.ending.delete(ending));
  }

  private release(): void {
    clearInterval(this.meterTimer);
    this.meterTimer = undefined;
    this.meter?.close();
    this.meter = null;
  }
}
