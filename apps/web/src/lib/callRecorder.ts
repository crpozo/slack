// ---------------------------------------------------------------------------
// The call's recording for AI notes (Phase 40). While notes are on, the
// caller's app records one track with both voices: its own microphone and
// the other side's audio, mixed with Web Audio and encoded by MediaRecorder
// (Opus at 32 kbps, about 15 MB an hour). Recording pauses while notes are
// off. When the call ends the clip is uploaded and attached to the ✨ card.
// ---------------------------------------------------------------------------

/** The part of `MediaRecorder` this drives (a fake in tests). */
export interface RecorderLike {
  state: "inactive" | "recording" | "paused";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

/** The part of `AudioContext` this drives. */
export interface MixerLike {
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamDestination(): { stream: MediaStream };
  createMediaStreamSource(stream: MediaStream): {
    connect(destination: unknown): void;
    disconnect(): void;
  };
}

export interface CallRecording {
  blob: Blob;
  mimeType: string;
  /** How long notes were on (the clip's length), ms. */
  durationMs: number;
}

export interface RecorderDeps {
  createMixer: () => MixerLike;
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => RecorderLike;
  supportedType: (type: string) => boolean;
  now?: () => number;
}

/** Bits per second: speech stays clear, an hour stays around 15 MB. */
export const RECORDING_BITRATE = 32_000;
/** MediaRecorder hands over data in slices this long, so a crash loses little. */
const SLICE_MS = 10_000;
const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

function browserDeps(): RecorderDeps | null {
  if (
    typeof window === "undefined" ||
    typeof MediaRecorder === "undefined" ||
    typeof AudioContext === "undefined"
  ) {
    return null;
  }
  return {
    createMixer: () => new AudioContext() as unknown as MixerLike,
    createRecorder: (stream, options) => new MediaRecorder(stream, options) as RecorderLike,
    supportedType: (type) => MediaRecorder.isTypeSupported(type),
  };
}

/** The file extension for a recorded type: `.webm` or `.m4a`. */
export function recordingExtension(mimeType: string): string {
  return mimeType.startsWith("audio/mp4") ? "m4a" : "webm";
}

export class CallRecorder {
  private readonly mixer: MixerLike;
  private readonly destination: { stream: MediaStream };
  private readonly recorder: RecorderLike;
  private readonly chunks: Blob[] = [];
  private sources = new Map<MediaStreamTrack, { disconnect(): void }>();
  private readonly now: () => number;
  private recordedMs = 0;
  private since: number | null = null;
  private stopped: Promise<CallRecording | null> | null = null;

  /** `null` where the browser can't record (no MediaRecorder or Web Audio). */
  static create(deps: RecorderDeps | null = browserDeps()): CallRecorder | null {
    if (!deps) return null;
    const mimeType = TYPES.find((t) => deps.supportedType(t));
    if (!mimeType) return null;
    try {
      return new CallRecorder(deps, mimeType);
    } catch {
      return null;
    }
  }

  private constructor(deps: RecorderDeps, mimeType: string) {
    this.now = deps.now ?? Date.now;
    this.mixer = deps.createMixer();
    this.destination = this.mixer.createMediaStreamDestination();
    this.recorder = deps.createRecorder(this.destination.stream, {
      mimeType,
      audioBitsPerSecond: RECORDING_BITRATE,
    });
    this.recorder.ondataavailable = ({ data }) => {
      if (data.size > 0) this.chunks.push(data);
    };
  }

  /** What to mix: my microphone and the other side's audio (replaced as they change). */
  setSources(tracks: Array<MediaStreamTrack | null | undefined>): void {
    if (this.stopped) return;
    const wanted = new Set(tracks.filter((t): t is MediaStreamTrack => !!t && t.kind === "audio"));
    for (const [track, node] of this.sources) {
      if (wanted.has(track)) continue;
      node.disconnect();
      this.sources.delete(track);
    }
    for (const track of wanted) {
      if (this.sources.has(track)) continue;
      const node = this.mixer.createMediaStreamSource(new MediaStream([track]));
      node.connect(this.destination);
      this.sources.set(track, node);
    }
  }

  /** Records while `on` (notes are on), pauses otherwise. */
  setRecording(on: boolean): void {
    if (this.stopped) return;
    if (on) {
      if (this.mixer.state === "suspended") void this.mixer.resume().catch(() => {});
      if (this.recorder.state === "inactive") this.recorder.start(SLICE_MS);
      else if (this.recorder.state === "paused") this.recorder.resume();
      this.since ??= this.now();
    } else if (this.recorder.state === "recording") {
      this.recorder.pause();
      this.tally();
    }
  }

  /** Ends the recording: the clip, or `null` if nothing was recorded. */
  stop(): Promise<CallRecording | null> {
    if (this.stopped) return this.stopped;
    this.tally();
    this.stopped = new Promise((resolve) => {
      const finish = () => {
        this.release();
        const blob = new Blob(this.chunks, { type: this.recorder.mimeType });
        resolve(
          blob.size > 0 && this.recordedMs > 0
            ? { blob, mimeType: this.recorder.mimeType, durationMs: this.recordedMs }
            : null,
        );
      };
      if (this.recorder.state === "inactive") {
        finish();
        return;
      }
      this.recorder.onstop = finish;
      try {
        this.recorder.stop();
      } catch {
        finish();
      }
    });
    return this.stopped;
  }

  /** The call ended without notes to submit: drop the recording. */
  dispose(): void {
    if (!this.stopped) {
      this.stopped = Promise.resolve(null);
      this.recorder.ondataavailable = null;
      try {
        if (this.recorder.state !== "inactive") this.recorder.stop();
      } catch {
        // already stopped
      }
    }
    this.chunks.length = 0;
    this.release();
  }

  private tally(): void {
    if (this.since === null) return;
    this.recordedMs += this.now() - this.since;
    this.since = null;
  }

  private release(): void {
    this.sources.forEach((node) => node.disconnect());
    this.sources.clear();
    void this.mixer.close().catch(() => {});
  }
}
