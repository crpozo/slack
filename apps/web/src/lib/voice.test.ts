import { describe, expect, it, vi } from "vitest";
import { baseType, clipSeconds, formatDuration, pickAudioMime, voiceFileName } from "./voice";

describe("voice messages", () => {
  it("prefers MP4/AAC (plays everywhere), then WebM/Opus", () => {
    const safari = (t: string) => t === "audio/mp4";
    const chrome = (t: string) => t === "audio/mp4" || t.startsWith("audio/webm");
    const firefox = (t: string) => t.startsWith("audio/webm") || t.startsWith("audio/ogg");
    expect(pickAudioMime(safari)).toBe("audio/mp4");
    expect(pickAudioMime(chrome)).toBe("audio/mp4");
    expect(pickAudioMime(firefox)).toBe("audio/webm;codecs=opus");
    expect(pickAudioMime(() => false)).toBeNull();
  });

  it("signs uploads with the bare content type and names files by format", () => {
    expect(baseType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(baseType("audio/mp4")).toBe("audio/mp4");
    const at = new Date(2026, 9, 14, 9, 5);
    expect(voiceFileName("audio/mp4", at)).toBe("voice-2026-10-14-0905.m4a");
    expect(voiceFileName("audio/webm;codecs=opus", at)).toBe("voice-2026-10-14-0905.webm");
  });

  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(12_400)).toBe("0:12");
    expect(formatDuration(5 * 60_000)).toBe("5:00");
  });
});

describe("playback speed (Phase 36)", () => {
  it("cycles 1× → 1.5× → 2× → 1× and formats it", async () => {
    const { nextPlaybackRate, formatPlaybackRate } = await import("./voice");
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    expect(nextPlaybackRate(2)).toBe(1);
    expect(formatPlaybackRate(1.5)).toBe("1.5×");
  });

  it("is remembered on this device, ignoring anything it doesn't offer", async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
    const { loadPlaybackRate, savePlaybackRate } = await import("./voice");
    expect(loadPlaybackRate()).toBe(1);
    savePlaybackRate(2);
    expect(loadPlaybackRate()).toBe(2);
    store["slack.audio.playbackRate"] = "3";
    expect(loadPlaybackRate()).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("clipSeconds", () => {
  it("trusts the browser's duration once it's known", () => {
    expect(clipSeconds(12.4, 9_000)).toBe(12.4);
  });

  it("falls back to the recorded length while a WebM still reports Infinity", () => {
    expect(clipSeconds(Infinity, 9_000)).toBe(9);
    expect(clipSeconds(NaN, 9_000)).toBe(9);
    expect(clipSeconds(0, 9_000)).toBe(9);
  });

  it("is 0 when neither is known", () => {
    expect(clipSeconds(Infinity)).toBe(0);
    expect(clipSeconds(NaN, 0)).toBe(0);
  });
});
