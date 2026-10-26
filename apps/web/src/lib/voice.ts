import { useCallback, useEffect, useRef, useState } from "react";
import { loadMediaPrefs } from "./media";

/** Voice messages stop (and send) by themselves at this length. */
export const MAX_VOICE_MS = 5 * 60 * 1000;

/**
 * Recording formats in order of preference. AAC in MP4 first: it plays on every
 * browser, iPhones included (Safari records it; Chrome 126+ too). WebM/Opus is
 * the fallback (Firefox, older Chrome); iOS before 17 may not play those.
 */
const CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export function pickAudioMime(isTypeSupported: (type: string) => boolean): string | null {
  return CANDIDATES.find((type) => isTypeSupported(type)) ?? null;
}

/** `audio/webm;codecs=opus` → `audio/webm`: the content type S3 is signed for. */
export const baseType = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();

const EXTENSIONS: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

/** `voice-2026-10-14-0930.m4a` */
export function voiceFileName(mime: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `voice-${stamp}.${EXTENSIONS[baseType(mime)] ?? "audio"}`;
}

// --- Playback speed (Phase 36) ------------------------------------------------

/** What the speed button cycles through. */
export const PLAYBACK_RATES = [1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

const RATE_KEY = "slack.audio.playbackRate";
const rateListeners = new Set<(rate: PlaybackRate) => void>();

/** The speed chosen on this device (1× until changed, or if storage is unavailable). */
export function loadPlaybackRate(): PlaybackRate {
  try {
    const saved = Number(localStorage.getItem(RATE_KEY));
    return PLAYBACK_RATES.find((r) => r === saved) ?? 1;
  } catch {
    return 1;
  }
}

/** Saves the speed for this device and tells every player on screen. */
export function savePlaybackRate(rate: PlaybackRate): void {
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // Not remembered; this session still uses it.
  }
  rateListeners.forEach((fn) => fn(rate));
}

/** 1× → 1.5× → 2× → 1×. */
export function nextPlaybackRate(rate: PlaybackRate): PlaybackRate {
  const i = PLAYBACK_RATES.indexOf(rate);
  return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]!;
}

/** `1×`, `1.5×`, `2×`. */
export const formatPlaybackRate = (rate: number) => `${rate}×`;

/** The device's playback speed, shared live by every audio player. */
export function usePlaybackRate(): [PlaybackRate, (rate: PlaybackRate) => void] {
  const [rate, setRate] = useState<PlaybackRate>(loadPlaybackRate);
  useEffect(() => {
    rateListeners.add(setRate);
    return () => {
      rateListeners.delete(setRate);
    };
  }, []);
  return [rate, savePlaybackRate];
}

/** `m:ss` */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const supportsVoiceMessages = () =>
  typeof window !== "undefined" &&
  "MediaRecorder" in window &&
  !!navigator.mediaDevices?.getUserMedia &&
  pickAudioMime((t) => MediaRecorder.isTypeSupported(t)) !== null;

export interface VoiceClip {
  file: File;
  durationMs: number;
}

type RecorderState = "idle" | "starting" | "recording";

/**
 * Records one voice message with `MediaRecorder`. `start()` asks for the mic
 * (the one picked in Settings); `stop()` resolves with the clip; `cancel()`
 * discards it. Either way the microphone is released at once (iOS shows its
 * orange dot until then).
 */
export function useVoiceRecorder(onAutoStop: (clip: VoiceClip) => void) {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const autoStop = useRef(onAutoStop);
  autoStop.current = onAutoStop;

  const release = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    recorder.current = null;
    setState("idle");
    setElapsed(0);
    setLevel(0);
  }, []);

  useEffect(() => release, [release]);

  const finish = useCallback((): Promise<VoiceClip | null> => {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") {
      release();
      return Promise.resolve(null);
    }
    const durationMs = Math.min(MAX_VOICE_MS, Date.now() - startedAt.current);
    const mime = rec.mimeType || "audio/webm";
    return new Promise((resolve) => {
      rec.onstop = () => {
        const type = baseType(mime);
        const blob = new Blob(chunks.current, { type });
        chunks.current = [];
        release();
        resolve(
          blob.size > 0
            ? { file: new File([blob], voiceFileName(mime, new Date()), { type }), durationMs }
            : null,
        );
      };
      rec.stop();
    });
  }, [release]);

  const start = useCallback(async () => {
    if (recorder.current) return;
    const mime = pickAudioMime((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error("This browser can't record audio.");
    setState("starting");
    try {
      const { audioInputId } = loadMediaPrefs();
      const media = await navigator.mediaDevices.getUserMedia({
        audio: audioInputId ? { deviceId: { ideal: audioInputId } } : true,
      });
      stream.current = media;
      const rec = new MediaRecorder(media, { mimeType: mime, audioBitsPerSecond: 64_000 });
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      recorder.current = rec;
      rec.start(250);
      startedAt.current = Date.now();
      setState("recording");

      // Level meter: RMS of the input, ~10×/s.
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(media).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      tick.current = setInterval(() => {
        const ms = Date.now() - startedAt.current;
        setElapsed(ms);
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
        if (ms >= MAX_VOICE_MS) {
          void finish().then((clip) => clip && autoStop.current(clip));
        }
      }, 100);
    } catch (err) {
      release();
      throw err;
    }
  }, [finish, release]);

  const cancel = useCallback(() => {
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.stop();
    }
    chunks.current = [];
    release();
  }, [release]);

  return { state, elapsed, level, start, stop: finish, cancel };
}
