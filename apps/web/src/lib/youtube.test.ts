import { describe, expect, it } from "vitest";
import { embedUrl, parseStart, thumbnailUrl, youTubeVideoOf, youTubeVideosIn } from "./youtube";

const ID = "dQw4w9WgXcQ";

describe("YouTube links", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, 0],
    [`https://youtube.com/watch?feature=share&v=${ID}&t=42`, 42],
    [`https://m.youtube.com/watch?v=${ID}&t=1m30s`, 90],
    [`https://music.youtube.com/watch?v=${ID}&si=abc`, 0],
    [`https://youtu.be/${ID}?si=xyz&t=90s`, 90],
    [`https://www.youtube.com/shorts/${ID}`, 0],
    [`https://www.youtube.com/live/${ID}?start=3600`, 3600],
    [`https://www.youtube.com/embed/${ID}`, 0],
    [`https://www.youtube-nocookie.com/embed/${ID}`, 0],
    [`https://www.youtube.com/watch?v=${ID}#t=1h2m3s`, 3723],
  ])("finds the video in %s", (link, start) => {
    expect(youTubeVideoOf(link)).toEqual({ id: ID, start });
  });

  it.each([
    "https://www.youtube.com/",
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/playlist?list=PL123",
    `https://www.youtube.com/watch?v=${ID}x`, // 12 characters
    'https://www.youtube.com/watch?v=abc"onload=x',
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/youtu.be/${ID}`,
    `javascript:alert(1)//youtu.be/${ID}`,
    "not a url",
  ])("ignores %s", (link) => {
    expect(youTubeVideoOf(link)).toBeNull();
  });

  it("parses start times", () => {
    expect(parseStart("90")).toBe(90);
    expect(parseStart("90s")).toBe(90);
    expect(parseStart("2m")).toBe(120);
    expect(parseStart("1h2m3s")).toBe(3723);
    expect(parseStart("abc")).toBe(0);
    expect(parseStart(null)).toBe(0);
  });

  it("takes each video once, at most two per message, never from code", () => {
    const text = [
      `Watch https://youtu.be/${ID} and again https://www.youtube.com/watch?v=${ID}.`,
      "Also https://youtu.be/aaaaaaaaaaa and https://youtu.be/bbbbbbbbbbb",
      "`https://youtu.be/ccccccccccc` and ```\nhttps://youtu.be/ddddddddddd\n```",
    ].join("\n");
    expect(youTubeVideosIn(text).map((v) => v.id)).toEqual([ID, "aaaaaaaaaaa"]);
    expect(youTubeVideosIn("`https://youtu.be/ccccccccccc`")).toEqual([]);
    expect(youTubeVideosIn("no links here")).toEqual([]);
  });

  it("plays from youtube-nocookie with autoplay, and shows the i.ytimg.com thumbnail first", () => {
    expect(embedUrl({ id: ID, start: 0 })).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1`,
    );
    expect(embedUrl({ id: ID, start: 90 })).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1&start=90`,
    );
    expect(thumbnailUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });
});
