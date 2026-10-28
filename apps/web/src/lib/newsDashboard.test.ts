import type { NewsArticle, NewsStory } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  dashboardDateLabel,
  dashboardStories,
  highlightParts,
  storyOf,
  timeAgo,
} from "./newsDashboard";

const article = (n: number, patch: Partial<NewsArticle> = {}): NewsArticle => ({
  title: `Story ${n}`,
  link: `https://techcrunch.com/${n}/`,
  snippet: `Snippet ${n}`,
  pubDate: null,
  imageUrl: null,
  sourceName: "TechCrunch",
  ...patch,
});

const pick = (n: number, patch: Partial<NewsStory> = {}): NewsStory => ({
  ...storyOf(article(n)),
  headline: `Titular ${n}`,
  summary: `Resumen ${n}`,
  ...patch,
});

describe("dashboardStories", () => {
  const articles = Array.from({ length: 7 }, (_, i) => article(i + 1));

  it("puts the analysis's picks on top and every other live story below", () => {
    const { top, more } = dashboardStories(
      { stories: [pick(3), pick(5, { link: "https://www.techcrunch.com/5?utm_source=rss" })] },
      articles,
    );
    expect(top.map((s) => s.headline)).toEqual(["Titular 3", "Titular 5"]);
    // The same page under another address isn't repeated below.
    expect(more.map((s) => s.headline)).toEqual([
      "Story 1",
      "Story 2",
      "Story 4",
      "Story 6",
      "Story 7",
    ]);
  });

  it("shows the newest four as they are while there's no analysis", () => {
    const { top, more } = dashboardStories(null, articles);
    expect(top.map((s) => s.headline)).toEqual(["Story 1", "Story 2", "Story 3", "Story 4"]);
    expect(top[0]).toEqual({
      headline: "Story 1",
      summary: "Snippet 1",
      sourceName: "TechCrunch",
      link: "https://techcrunch.com/1/",
      thumbnailUrl: null,
      pubDate: null,
    });
    expect(more).toHaveLength(3);
    expect(dashboardStories({ stories: [] }, articles).top).toHaveLength(4);
  });
});

describe("highlightParts", () => {
  it("marks **key phrases** and leaves the rest as text", () => {
    expect(
      highlightParts("La carrera es por la **eficiencia** y los **modelos pequeños**."),
    ).toEqual([
      { text: "La carrera es por la ", mark: false },
      { text: "eficiencia", mark: true },
      { text: " y los ", mark: false },
      { text: "modelos pequeños", mark: true },
      { text: ".", mark: false },
    ]);
  });

  it("never reads HTML, and leaves an unpaired marker as written", () => {
    expect(highlightParts("<b>x</b> **y")).toEqual([{ text: "<b>x</b> **y", mark: false }]);
    expect(highlightParts("")).toEqual([]);
  });
});

describe("dates", () => {
  it("labels the analysis's day in Spanish, in Ecuador", () => {
    expect(dashboardDateLabel("2026-10-28")).toBe("Mié 28 oct 2026");
    // No analysis: today, as it is in Ecuador (01:00 UTC is still the 27th there).
    expect(dashboardDateLabel(null, Date.parse("2026-10-28T01:00:00Z"))).toBe("Mar 27 oct 2026");
  });

  it("says how long ago in Spanish", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(timeAgo("2026-10-28T11:59:30Z", now)).toBe("hace un momento");
    expect(timeAgo("2026-10-28T11:48:00Z", now)).toBe("hace 12 min");
    expect(timeAgo("2026-10-28T10:00:00Z", now)).toBe("hace 2 h");
    expect(timeAgo("2026-10-26T12:00:00Z", now)).toBe("hace 2 d");
    expect(timeAgo("2026-10-01T12:00:00Z", now)).toMatch(/^1 oct/);
    expect(timeAgo(null, now)).toBe("");
  });
});
