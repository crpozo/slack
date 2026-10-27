// ---------------------------------------------------------------------------
// Local speech-to-text for AI call notes (Phase 28): the browser's speech
// recognition, kept running for as long as it's wanted. Browsers end a
// recognition session on their own (about a minute of silence, a network
// blip, every few minutes regardless), so `Transcriber` restarts it: at once
// after a healthy session, with growing pauses after sessions that die
// quickly, and never after a fatal error (no permission, no microphone, an
// unsupported language). Only finished phrases come out, stamped with when
// the person started saying them.
// ---------------------------------------------------------------------------

/** The part of `SpeechRecognitionResultList` this reads. */
interface ResultListLike {
  length: number;
  [index: number]: { isFinal: boolean; length: number; [index: number]: { transcript: string } };
}

/** The part of `SpeechRecognition` this drives (a fake in tests). */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chrome's on-device mode, where the language pack is installed. */
  processLocally?: boolean;
  onresult: ((event: { resultIndex: number; results: ResultListLike }) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  /** Newer Chrome takes the audio track to listen to; others ignore the argument. */
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

export type TranscriberState =
  { kind: "off" } | { kind: "listening" } | { kind: "unavailable"; reason: string };

/** Errors that end transcription for good: restarting would only fail again. */
const FATAL: Record<string, string> = {
  "not-allowed": "Microphone access for speech recognition was denied.",
  "service-not-allowed": "This browser doesn't allow speech recognition here.",
  "audio-capture": "No microphone is available for speech recognition.",
  "language-not-supported": "Speech recognition doesn't support this language.",
};

/** A session at least this long was healthy: restart at once. */
export const HEALTHY_SESSION_MS = 5_000;
export const MIN_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 10_000;

export interface TranscriberDeps {
  create: () => RecognitionLike;
  lang: string;
  onPhrase: (text: string, at: number) => void;
  onState?: (state: TranscriberState) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class Transcriber {
  private rec: RecognitionLike | null = null;
  private wanted = false;
  private running = false;
  private stopping = false;
  /** The session was stopped on purpose to restart (a new microphone): no backoff. */
  private restartAtOnce = false;
  private fatal: string | null = null;
  private track: MediaStreamTrack | null = null;
  private sessionStart = 0;
  private heardInSession = false;
  private phraseAt: number | null = null;
  private backoff = MIN_BACKOFF_MS;
  private restartTimer: unknown = null;
  private state: TranscriberState = { kind: "off" };
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly deps: TranscriberDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get current(): TranscriberState {
    return this.state;
  }

  /**
   * Listen (or stop listening). `track`: the call's microphone, so recognition
   * hears the device picked for the call where the browser supports it; a new
   * track restarts the session on it.
   */
  setWanted(wanted: boolean, track: MediaStreamTrack | null = null): void {
    const trackChanged = track !== this.track;
    this.track = track;
    this.wanted = wanted;
    if (!wanted) {
      this.cancelRestart();
      if (this.running && !this.stopping) {
        this.stopping = true;
        this.rec?.stop(); // a phrase in progress still arrives as final
      }
      if (!this.running) this.setState(this.fatal ? this.unavailable() : { kind: "off" });
      return;
    }
    if (this.fatal) return;
    if (this.running && trackChanged && !this.stopping) {
      this.stopping = true;
      this.restartAtOnce = true;
      this.rec?.stop(); // `onend` restarts on the new track
      return;
    }
    if (!this.running && this.restartTimer === null) this.startSession();
  }

  /** Stops for good (the call ended). */
  dispose(): void {
    this.wanted = false;
    this.cancelRestart();
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = rec.onspeechstart = null;
      try {
        rec.abort();
      } catch {
        // Already ended.
      }
    }
    this.running = false;
    this.setState({ kind: "off" });
  }

  private unavailable(): TranscriberState {
    return { kind: "unavailable", reason: this.fatal ?? "" };
  }

  private setState(next: TranscriberState): void {
    if (
      next.kind === this.state.kind &&
      (next.kind !== "unavailable" ||
        (this.state.kind === "unavailable" && next.reason === this.state.reason))
    ) {
      return;
    }
    this.state = next;
    this.deps.onState?.(next);
  }

  private cancelRestart(): void {
    if (this.restartTimer !== null) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  private recognition(): RecognitionLike {
    if (this.rec) return this.rec;
    const rec = this.deps.create();
    rec.lang = this.deps.lang;
    rec.continuous = true;
    rec.interimResults = true; // a phrase's start time comes from its first interim result
    rec.maxAlternatives = 1;
    rec.onspeechstart = () => {
      this.phraseAt ??= this.now();
    };
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        this.phraseAt ??= this.now();
        if (!result.isFinal) continue;
        const text = (result[0]?.transcript ?? "").replace(/\s+/g, " ").trim();
        const at = this.phraseAt;
        this.phraseAt = null;
        if (!text) continue;
        this.heardInSession = true;
        this.deps.onPhrase(text, at);
      }
    };
    rec.onerror = (event) => {
      const reason = FATAL[event.error];
      if (reason) {
        this.fatal = reason;
        this.setState(this.unavailable());
      }
      // `no-speech`, `aborted`, `network`…: `onend` follows and decides.
    };
    rec.onend = () => this.ended();
    this.rec = rec;
    return rec;
  }

  private startSession(): void {
    this.restartTimer = null;
    if (!this.wanted || this.fatal || this.running) return;
    const rec = this.recognition();
    try {
      if (this.track) rec.start(this.track);
      else rec.start();
    } catch (err) {
      // InvalidStateError: it is already running (a late `onend` is coming).
      if ((err as { name?: string })?.name !== "InvalidStateError") {
        this.fatal = "Speech recognition couldn't start.";
        this.setState(this.unavailable());
        return;
      }
    }
    this.running = true;
    this.stopping = false;
    this.sessionStart = this.now();
    this.heardInSession = false;
    this.setState({ kind: "listening" });
  }

  private ended(): void {
    this.running = false;
    this.stopping = false;
    this.phraseAt = null;
    if (this.fatal || !this.wanted) this.restartAtOnce = false;
    if (this.fatal) return this.setState(this.unavailable());
    if (!this.wanted) return this.setState({ kind: "off" });
    // Healthy sessions restart at once; ones that die young back off, so a
    // broken recognizer can't spin the CPU.
    let delay = 0;
    if (this.restartAtOnce) {
      this.restartAtOnce = false;
    } else if (this.heardInSession || this.now() - this.sessionStart >= HEALTHY_SESSION_MS) {
      this.backoff = MIN_BACKOFF_MS;
    } else {
      delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    }
    this.restartTimer = this.setTimer(() => this.startSession(), delay);
  }
}

type RecognitionCtor = new () => RecognitionLike;

/** The browser's speech recognition constructor, if it has one (Chrome, Edge, Safari). */
export function speechRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Whether `lang` can be recognized on this device (Chrome's on-device mode,
 * with its language pack installed). Elsewhere the browser's speech service
 * does the work, which may mean its own servers.
 */
export async function canTranscribeOnDevice(lang: string): Promise<boolean> {
  const ctor = speechRecognitionCtor() as
    | (RecognitionCtor & {
        available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>;
      })
    | null;
  if (!ctor?.available) return false;
  try {
    return (await ctor.available({ langs: [lang], processLocally: true })) === "available";
  } catch {
    return false;
  }
}

/**
 * The language to recognize: always Spanish (Ecuador), whatever the browser's
 * own language (Phase 40). Recognizing with an English browser's `en-US` made
 * Spanish speech and background noise come out as random English words.
 */
export const SPEECH_LANG = "es-EC";
export const speechLang = (): string => SPEECH_LANG;
