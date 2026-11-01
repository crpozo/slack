import type { NewsArticle } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { coverImageOf, resetCoverCache, withCoverImages } from "../src/lib/news";

const story = (n: number, imageUrl: string | null = null): NewsArticle => ({
  title: `Story ${n}`,
  link: `https://techcrunch.com/2026/11/01/story-${n}/`,
  snippet: "",
  pubDate: null,
  imageUrl,
  sourceName: "TechCrunch",
});

const page = (head: string) =>
  new Response(`<!doctype html><html><head>${head}</head><body>${"x".repeat(1000)}</body></html>`, {
    headers: { "content-type": "text/html; charset=UTF-8" },
  });

describe("coverImageOf", () => {
  it("takes og:image (any attribute order), else twitter:image; https and absolute only", () => {
    expect(
      coverImageOf(
        `<meta content="https://techcrunch.com/wp-content/uploads/a.jpg?w=1200&amp;h=675" property="og:image">`,
        "https://techcrunch.com/x/",
      ),
    ).toBe("https://techcrunch.com/wp-content/uploads/a.jpg?w=1200&h=675");
    expect(
      coverImageOf(`<meta name="twitter:image" content="/img/b.png">`, "https://techcrunch.com/x/"),
    ).toBe("https://techcrunch.com/img/b.png");
    expect(
      coverImageOf(`<meta property="og:image" content="http://insecure/c.jpg">`, "https://a.b/"),
    ).toBeNull();
    expect(coverImageOf(`<meta property="og:title" content="Hi">`, "https://a.b/")).toBeNull();
  });
});

describe("withCoverImages", () => {
  beforeEach(() => resetCoverCache());

  it("fills only the stories without an image, from their pages, and remembers them", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("story-1")
        ? page(`<meta property="og:image" content="https://techcrunch.com/cover-1.jpg">`)
        : page(""),
    );
    const articles = [story(1), story(2), story(3, "https://infoq.com/has-one.jpg")];
    const first = await withCoverImages(articles, fetchImpl as unknown as typeof fetch);
    expect(first.map((a) => a.imageUrl)).toEqual([
      "https://techcrunch.com/cover-1.jpg",
      null,
      "https://infoq.com/has-one.jpg",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // never the story that already had one
    await withCoverImages(articles, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // remembered, the missing one too
  });

  it("never fails: a page that errors, isn't HTML or is down leaves the fallback", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response("gone", { status: 404, headers: { "content-type": "text/html" } }),
      );
    const out = await withCoverImages(
      [story(1), story(2), story(3)],
      fetchImpl as unknown as typeof fetch,
    );
    expect(out.map((a) => a.imageUrl)).toEqual([null, null, null]);
  });
});
