/**
 * Notification sounds, synthesized with Web Audio: no audio files, nothing to
 * download or host. Three sounds:
 *   - "outgoing": a soft, slow ring for the caller while the other side is rung
 *   - "incoming": the brighter two-tone ring under the incoming-call card
 *   - "message": a short two-note pop for a new message
 *
 * Browsers block audio until the page has had a user gesture. Every start is
 * wrapped so a blocked context just stays silent (the visual notification still
 * shows), and `installAudioUnlock` resumes the context on the first click or key
 * so rings that arrive later can be heard.
 */

export type RingKind = "outgoing" | "incoming";

const STORAGE_KEY = "slack.sounds";
let context: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | undefined;
let ringing: RingKind | null = null;
const listeners = new Set<(enabled: boolean) => void>();

// --- Preference ---------------------------------------------------------------

/** Whether notification sounds are on (default: on). */
export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this page only (see `muted`).
  }
  muted = !enabled;
  if (!enabled) stopRinging();
  listeners.forEach((fn) => fn(enabled));
}

/** In-memory copy, so a storage failure still mutes this page. */
let muted = !soundsEnabled();

export function onSoundsChange(fn: (enabled: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- Audio context --------------------------------------------------------------

/** The shared context, created on first use; `null` where Web Audio is missing. */
function audio(): AudioContext | null {
  if (context) return context;
  try {
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

/** Resumes a context the browser suspended; failures are expected and ignored. */
async function unlock(): Promise<boolean> {
  const ctx = audio();
  if (!ctx) return false;
  try {
    if (ctx.state !== "running") await ctx.resume();
    return ctx.state === "running";
  } catch {
    return false;
  }
}

/**
 * Autoplay policy: resume the context on the first gesture so that sounds
 * started later by network events (a call, a message) can play.
 */
export function installAudioUnlock(target: EventTarget = window): () => void {
  const onGesture = () => {
    void unlock().then((ok) => ok && remove());
  };
  const remove = () => {
    target.removeEventListener("pointerdown", onGesture);
    target.removeEventListener("keydown", onGesture);
  };
  target.addEventListener("pointerdown", onGesture);
  target.addEventListener("keydown", onGesture);
  return remove;
}

// --- Synthesis ------------------------------------------------------------------

interface Tone {
  /** Seconds after the pattern starts. */
  at: number;
  frequency: number;
  duration: number;
  volume: number;
  type?: OscillatorType;
}

function play(ctx: AudioContext, tones: Tone[]): void {
  const start = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type ?? "sine";
    osc.frequency.value = tone.frequency;
    const t0 = start + tone.at;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(tone.volume, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + tone.duration + 0.05);
  }
}

/** One cycle of each ring pattern, and how often it repeats. */
const RINGS: Record<RingKind, { tones: Tone[]; everyMs: number }> = {
  // Like a phone line ringing on the other end: one long, low "brrr", then silence.
  outgoing: {
    tones: [
      { at: 0, frequency: 440, duration: 1.0, volume: 0.07 },
      { at: 0, frequency: 480, duration: 1.0, volume: 0.07 },
    ],
    everyMs: 3000,
  },
  // Attention-getting two-tone chime, twice.
  incoming: {
    tones: [
      { at: 0, frequency: 880, duration: 0.35, volume: 0.15 },
      { at: 0.45, frequency: 660, duration: 0.35, volume: 0.15 },
      { at: 1.0, frequency: 880, duration: 0.35, volume: 0.15 },
      { at: 1.45, frequency: 660, duration: 0.35, volume: 0.15 },
    ],
    everyMs: 3000,
  },
};

/** Short, soft "pop": two quick rising notes. */
const MESSAGE_POP: Tone[] = [
  { at: 0, frequency: 740, duration: 0.12, volume: 0.08, type: "triangle" },
  { at: 0.1, frequency: 988, duration: 0.18, volume: 0.08, type: "triangle" },
];

// --- Public API ------------------------------------------------------------------

/** Which ring is playing, if any (for tests and the UI). */
export function currentRing(): RingKind | null {
  return ringing;
}

/**
 * Loops `kind` until `stopRinging`. Starting another kind replaces the loop;
 * starting the same kind again is a no-op. Silent while sounds are off.
 */
export function startRinging(kind: RingKind): void {
  if (ringing === kind) return;
  stopRinging();
  if (muted) return;
  const ctx = audio();
  if (!ctx) return;
  ringing = kind;
  const pattern = RINGS[kind];
  // Each cycle re-checks the context: while audio is blocked nothing is scheduled
  // (tones queued on a suspended context would all burst out once it resumes),
  // and a gesture during the ring lets the next cycle be heard.
  const cycle = () =>
    void unlock().then((ok) => {
      if (!ok || ringing !== kind) return;
      try {
        play(ctx, pattern.tones);
      } catch {
        stopRinging(); // the context died; stay quiet rather than throw every cycle
      }
    });
  cycle();
  ringTimer = setInterval(cycle, pattern.everyMs);
}

export function stopRinging(): void {
  clearInterval(ringTimer);
  ringTimer = undefined;
  ringing = null;
}

/** Plays the message pop once; silent while sounds are off or audio is blocked. */
export function playMessageSound(): void {
  if (muted) return;
  const ctx = audio();
  if (!ctx) return;
  void unlock().then((ok) => {
    if (!ok) return;
    try {
      play(ctx, MESSAGE_POP);
    } catch {
      // Nothing to do: a failed notification sound is not an error worth surfacing.
    }
  });
}
