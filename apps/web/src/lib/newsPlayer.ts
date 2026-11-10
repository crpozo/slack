import { create } from "zustand";

// ---------------------------------------------------------------------------
// The AI News audio summary's player (Phase 56). One <audio> for the whole
// app, never inside a view: leaving AI News for a channel or a board unmounts
// the view, not the sound. The view shows its controls; everywhere else a
// small pill does (`NewsAudioPill`).
// ---------------------------------------------------------------------------

export interface NewsPlayerState {
  /** The track loaded (its URL without the signature), or `null` before the first play. */
  track: string | null;
  playing: boolean;
  /** Seconds. */
  position: number;
  /** Seconds; 0 until the file says. */
  duration: number;
  error: string | null;
  /** Plays `url`, or pauses it when it's the one playing. */
  toggle: (url: string) => void;
  seek: (seconds: number) => void;
  /** Stops and forgets the track (the pill's ✕). */
  stop: () => void;
}

/** A presigned URL without its signature: the same file keeps the same key across reloads. */
export const trackOf = (url: string): string => url.split("?")[0] ?? url;

let audio: HTMLAudioElement | null = null;

export const useNewsPlayer = create<NewsPlayerState>((set, get) => {
  function element(): HTMLAudioElement {
    if (audio) return audio;
    const el = new Audio();
    el.preload = "none";
    el.addEventListener("play", () => set({ playing: true, error: null }));
    el.addEventListener("pause", () => set({ playing: false }));
    el.addEventListener("ended", () => set({ playing: false, position: 0 }));
    el.addEventListener("timeupdate", () => set({ position: el.currentTime }));
    el.addEventListener("durationchange", () =>
      set({ duration: Number.isFinite(el.duration) ? el.duration : 0 }),
    );
    el.addEventListener("error", () =>
      set({ playing: false, error: "No se pudo reproducir el audio. Recarga AI News." }),
    );
    audio = el;
    return el;
  }
  return {
    track: null,
    playing: false,
    position: 0,
    duration: 0,
    error: null,
    toggle: (url) => {
      const el = element();
      const track = trackOf(url);
      if (get().track !== track || !el.src) {
        // Another day's summary (or the first play): load it. The same file with a
        // fresh signature keeps playing where it is.
        el.src = url;
        set({ track, position: 0, duration: 0, error: null });
      } else if (!el.paused) {
        el.pause();
        return;
      }
      void el.play().catch(() => set({ playing: false }));
    },
    seek: (seconds) => {
      if (!audio) return;
      audio.currentTime = seconds;
      set({ position: seconds });
    },
    stop: () => {
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      set({ track: null, playing: false, position: 0, duration: 0, error: null });
    },
  };
});

/** "1:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
