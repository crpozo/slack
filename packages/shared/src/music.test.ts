import { describe, expect, it } from "vitest";
import { controlsMusic, musicPositionMs, youTubeIdOf } from "./music";

describe("Música (Phase 78)", () => {
  it("the room's clock: the position moves while it plays, stays while paused", () => {
    expect(musicPositionMs({ playing: true, positionMs: 30_000, at: 1_000 }, 6_000)).toBe(35_000);
    expect(musicPositionMs({ playing: false, positionMs: 30_000, at: 1_000 }, 6_000)).toBe(30_000);
    // A listener's clock slightly behind the server's never goes negative.
    expect(musicPositionMs({ playing: true, positionMs: 0, at: 5_000 }, 4_000)).toBe(0);
  });

  it("reads the video of any YouTube link, and nothing else", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=X3G2C15azIs&list=abc",
      "https://youtu.be/X3G2C15azIs?t=30",
      "https://music.youtube.com/watch?v=X3G2C15azIs",
      "https://m.youtube.com/shorts/X3G2C15azIs",
    ]) {
      expect(youTubeIdOf(link), link).toBe("X3G2C15azIs");
    }
    for (const link of [
      "https://vimeo.com/123",
      "youtube",
      "https://www.youtube.com/watch?v=short",
      "javascript:alert(1)",
    ]) {
      expect(youTubeIdOf(link), link).toBeNull();
    }
  });

  it("the DJ controls the room; an admin can step in; an external never", () => {
    const room = { djId: "dj" };
    expect(controlsMusic(room, "dj", "member")).toBe(true);
    expect(controlsMusic(room, "other", "member")).toBe(false);
    expect(controlsMusic(room, "other", "admin")).toBe(true);
    expect(controlsMusic(room, "dj", "guest")).toBe(false);
  });
});
