import { describe, expect, it } from "vitest";
import { baseType, formatDuration, pickAudioMime, voiceFileName } from "./voice";

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
