// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clock, rateLabel, trackOf, useNewsPlayer } from "./newsPlayer";

// Phase 56: the AI News audio is one player for the whole app (it survives leaving the view).

describe("the news audio player", () => {
  const play = vi.fn(function (this: HTMLAudioElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.fn(function (this: HTMLAudioElement) {
    this.dispatchEvent(new Event("pause"));
  });
  beforeEach(() => {
    play.mockClear();
    pause.mockClear();
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.pause = pause;
    HTMLMediaElement.prototype.load = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get: () => !useNewsPlayer.getState().playing,
    });
    useNewsPlayer.getState().stop();
  });

  it("plays, pauses and resumes one track; a fresh signature of the same file doesn't restart it", () => {
    const { toggle } = useNewsPlayer.getState();
    toggle("https://b/news-audio/a.mp3?sig=1");
    expect(useNewsPlayer.getState()).toMatchObject({
      track: "https://b/news-audio/a.mp3",
      playing: true,
    });
    toggle("https://b/news-audio/a.mp3?sig=2"); // the page reloaded its URL: same file
    expect(useNewsPlayer.getState().playing).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    toggle("https://b/news-audio/a.mp3?sig=2");
    expect(useNewsPlayer.getState().playing).toBe(true);
    useNewsPlayer.getState().stop();
    expect(useNewsPlayer.getState()).toMatchObject({ track: null, playing: false });
  });

  it("formats time and keys a track without its signature", () => {
    expect(clock(254)).toBe("4:14");
    expect(clock(5.9)).toBe("0:05");
    expect(trackOf("https://b/x.mp3?X-Amz=1")).toBe("https://b/x.mp3");
  });

  it("steps through the speeds, applies them to the audio and remembers them", () => {
    const { toggle } = useNewsPlayer.getState();
    toggle("https://b/news-audio/a.mp3?sig=1");
    expect(useNewsPlayer.getState().rate).toBe(1);
    useNewsPlayer.getState().cycleRate();
    useNewsPlayer.getState().cycleRate();
    expect(useNewsPlayer.getState().rate).toBe(1.5);
    expect(localStorage.getItem("news-audio-rate")).toBe("1.5");
    // Another track keeps the speed.
    toggle("https://b/news-audio/b.mp3?sig=1");
    const el = (play.mock.contexts.at(-1) ?? null) as HTMLAudioElement | null;
    expect(el?.playbackRate).toBe(1.5);
    expect(rateLabel(1.5)).toBe("1,5×");
    // After 2× comes 0.75×, then back to 1×.
    for (let i = 0; i < 3; i++) useNewsPlayer.getState().cycleRate();
    expect(useNewsPlayer.getState().rate).toBe(0.75);
    useNewsPlayer.getState().cycleRate();
    expect(useNewsPlayer.getState().rate).toBe(1);
  });
});
