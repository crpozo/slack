import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/news";
import type { HttpEvent } from "../src/lib/http";
import {
  clip,
  getNews,
  imageOf,
  parseFeed,
  plainText,
  resetNewsCache,
  RETRY_AFTER_FAILURE_MS,
} from "../src/lib/news";
import { resetMocks } from "./helpers";

const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>AI News | TechCrunch</title><link>https://techcrunch.com</link>${items}</channel></rss>`;

const item = (fields: string) => `<item>${fields}</item>`;

/** A WordPress-style item: CDATA description with entities and the footer, an image in media:content. */
const MEDIA_ITEM = item(`
  <title>OpenAI&#8217;s new model &amp; what it means</title>
  <link>https://techcrunch.com/2026/10/26/openai-model/</link>
  <dc:creator><![CDATA[Kyle Wiggers]]></dc:creator>
  <pubDate>Mon, 26 Oct 2026 14:05:00 +0000</pubDate>
  <category><![CDATA[AI]]></category>
  <category><![CDATA[OpenAI]]></category>
  <guid isPermaLink="false">https://techcrunch.com/?p=1</guid>
  <description><![CDATA[<p>OpenAI on Monday released a model that &#8220;thinks&#8221; longer&hellip;</p>
  <p>The post <a href="https://techcrunch.com/x">OpenAI&#8217;s new model</a> appeared first on <a href="https://techcrunch.com">TechCrunch</a>.</p>]]></description>
  <media:content url="https://techcrunch.com/wp-content/uploads/small.jpg" medium="image" width="300" />
  <media:content url="https://techcrunch.com/wp-content/uploads/large.jpg?w=1200" medium="image" width="1200">
    <media:title type="html">Sam Altman</media:title>
  </media:content>`);

describe("parseFeed", () => {
  it("reads a WordPress item: decoded title, clean snippet without the footer, ISO date, widest image", () => {
    const [article] = parseFeed(rss(MEDIA_ITEM));
    expect(article).toEqual({
      title: "OpenAI’s new model & what it means",
      link: "https://techcrunch.com/2026/10/26/openai-model/",
      snippet: "OpenAI on Monday released a model that “thinks” longer…",
      pubDate: "2026-10-26T14:05:00.000Z",
      imageUrl: "https://techcrunch.com/wp-content/uploads/large.jpg?w=1200",
    });
  });

  it("finds the image in every place a feed may put it, in order", () => {
    const base = `<title>T</title><link>https://techcrunch.com/a</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate>`;
    const image = (extra: string) => parseFeed(rss(item(base + extra)))[0]?.imageUrl;
    expect(image(`<media:thumbnail url="https://cdn.example/thumb.png" />`)).toBe(
      "https://cdn.example/thumb.png",
    );
    expect(
      image(`<enclosure url="https://cdn.example/e.webp" type="image/webp" length="1" />`),
    ).toBe("https://cdn.example/e.webp");
    // An audio enclosure isn't an image.
    expect(
      image(`<enclosure url="https://cdn.example/a.mp3" type="audio/mpeg" length="1" />`),
    ).toBeNull();
    expect(
      image(
        `<content:encoded><![CDATA[<p>Hi</p><img class="x" src="https://cdn.example/in-body.jpg?w=680&amp;h=383" alt="" />]]></content:encoded>`,
      ),
    ).toBe("https://cdn.example/in-body.jpg?w=680&h=383");
    expect(
      image(`<description><![CDATA[<img src='https://cdn.example/d.gif'>text]]></description>`),
    ).toBe("https://cdn.example/d.gif");
    // media:content beats the others; insecure or relative URLs never count.
    expect(
      image(
        `<media:thumbnail url="https://cdn.example/thumb.png" /><media:content url="https://cdn.example/m.jpg" type="image/jpeg" />`,
      ),
    ).toBe("https://cdn.example/m.jpg");
    expect(image(`<media:content url="http://cdn.example/m.jpg" medium="image" />`)).toBeNull();
    expect(image(`<description><![CDATA[<img src="/relative.jpg">]]></description>`)).toBeNull();
    expect(image("")).toBeNull();
  });

  it("orders newest first, skips items without a title or an https link, keeps 15", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      item(
        `<title>Story ${i}</title><link>https://techcrunch.com/${i}</link><pubDate>Mon, ${String(
          (i % 28) + 1,
        ).padStart(2, "0")} Sep 2026 10:00:00 +0000</pubDate>`,
      ),
    );
    const bad = [
      item(`<title></title><link>https://techcrunch.com/x</link>`),
      item(`<title>Insecure</title><link>http://techcrunch.com/y</link>`),
      item(`<title>No link</title>`),
    ];
    const articles = parseFeed(rss([...bad, ...many].join("")));
    expect(articles).toHaveLength(15);
    expect(articles[0]?.title).toBe("Story 19");
    expect(articles.map((a) => a.pubDate)).toEqual(
      [...articles.map((a) => a.pubDate)].sort().reverse(),
    );
    // A title that looks like a number stays a string.
    expect(
      parseFeed(rss(item(`<title>2026</title><link>https://techcrunch.com/z</link>`)))[0],
    ).toMatchObject({
      title: "2026",
      pubDate: null,
      snippet: "",
    });
  });

  it("refuses what isn't RSS", () => {
    expect(() => parseFeed("<html><body>Blocked</body></html>")).toThrow("not an RSS feed");
  });
});

describe("text helpers", () => {
  it("strips tags and scripts, decodes entities, collapses whitespace", () => {
    expect(plainText("<p>A&nbsp;&amp;&#x27;b</p>\n<script>alert(1)</script><br/>c")).toBe(
      "A &'b c",
    );
  });

  it("cuts long snippets at a word with an ellipsis", () => {
    const long = "word ".repeat(80);
    const cut = clip(long, 50);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut.endsWith("word…")).toBe(true);
    expect(clip("short")).toBe("short");
  });

  it("reads images straight from an item object", () => {
    expect(imageOf({ "media:thumbnail": [{ "@_url": "https://x.example/t.png" }] })).toBe(
      "https://x.example/t.png",
    );
  });
});

describe("getNews (the warm container's copy)", () => {
  const feed = rss(MEDIA_ITEM);
  const ok = () =>
    new Response(feed, {
      status: 200,
      headers: { "content-type": "application/rss+xml; charset=UTF-8" },
    });

  beforeEach(() => resetNewsCache());

  it("reads the feed once per 30 minutes", async () => {
    const fetchMock = vi.fn(async () => ok());
    const t0 = 1_800_000_000_000;
    const first = await getNews(fetchMock, t0);
    expect(first).toMatchObject({ fromCache: false, expiresAt: t0 + 1_800_000 });
    expect(first.response).toMatchObject({ source: "TechCrunch", fetchedAt: t0 });
    expect((await getNews(fetchMock, t0 + 29 * 60_000)).fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://techcrunch.com/category/artificial-intelligence/feed/",
      expect.objectContaining({ redirect: "follow" }),
    ]);
    await getNews(fetchMock, t0 + 30 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves the last good list, marked stale, when the feed fails; tries again a minute later", async () => {
    const t0 = 1_800_000_000_000;
    await getNews(
      vi.fn(async () => ok()),
      t0,
    );
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    const later = t0 + 31 * 60_000;
    const stale = await getNews(down, later);
    expect(stale.response.stale).toBe(true);
    expect(stale.response.articles).toHaveLength(1);
    expect(stale.expiresAt).toBe(later + RETRY_AFTER_FAILURE_MS);
    await getNews(down, later + 30_000); // within the minute: no new attempt
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("throws when the feed fails and nothing was ever read, or answers with something else", async () => {
    await expect(getNews(vi.fn(async () => new Response("x", { status: 500 })))).rejects.toThrow(
      "feed answered 500",
    );
    await expect(
      getNews(
        vi.fn(
          async () =>
            new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
        ),
      ),
    ).rejects.toThrow("isn't XML");
  });
});

describe("GET /news", () => {
  const event = (routeKey = "GET /news", groups?: string[]): HttpEvent =>
    ({
      version: "2.0",
      routeKey,
      rawPath: "/news",
      rawQueryString: "",
      headers: {},
      isBase64Encoded: false,
      requestContext: {
        http: { method: "GET", path: "/news" },
        authorizer: {
          jwt: {
            claims: {
              sub: "user-alice",
              email: "alice@example.com",
              ...(groups && { "cognito:groups": `[${groups.join(" ")}]` }),
            },
            scopes: [],
          },
        },
      },
    }) as unknown as HttpEvent;
  const call = async (e: HttpEvent) =>
    (await handler(e)) as { statusCode: number; headers: Record<string, string>; body: string };

  beforeEach(() => {
    resetMocks();
    resetNewsCache();
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
  });

  it("answers the articles with a browser cache for what's left of the 30 minutes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(rss(MEDIA_ITEM), { headers: { "content-type": "text/xml" } })),
    );
    const first = await call(event());
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=1800, stale-while-revalidate=600");
    expect(JSON.parse(first.body).articles[0].title).toBe("OpenAI’s new model & what it means");

    vi.setSystemTime(1_800_000_000_000 + 10 * 60_000);
    const second = await call(event());
    expect(second.headers["cache-control"]).toBe(
      "public, max-age=1200, stale-while-revalidate=600",
    );
    vi.unstubAllGlobals();
  });

  it("502 when the feed can't be read and there's nothing cached; guests and other routes refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ENOTFOUND"))),
    );
    const failed = await call(event());
    expect(failed.statusCode).toBe(502);
    expect(JSON.parse(failed.body).message).toMatch(/TechCrunch/);
    expect((await call(event("GET /news", ["guests"]))).statusCode).toBe(403);
    expect((await call(event("POST /news"))).statusCode).toBe(404);
    vi.unstubAllGlobals();
  });
});
