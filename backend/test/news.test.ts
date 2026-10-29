import { NEWS_FEEDS, NEWS_MAX_AGE_MS } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/news";
import type { HttpEvent } from "../src/lib/http";
import {
  clip,
  feedTime,
  getNews,
  imageOf,
  isAboutAi,
  mergeArticles,
  parseFeed as parseAnyFeed,
  plainText,
  readAllSources,
  readFeed,
  resetNewsCache,
  RETRY_AFTER_FAILURE_MS,
  RETRY_PARTIAL_MS,
} from "../src/lib/news";
import { resetMocks } from "./helpers";

/**
 * "Now" for every test: the morning after the fixtures' stories (26 Oct
 * 2026), so they're inside the 48-hour window.
 */
const NOW = Date.parse("2026-10-27T08:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>AI News | TechCrunch</title><link>https://techcrunch.com</link>${items}</channel></rss>`;

const item = (fields: string) => `<item>${fields}</item>`;
/** A publication date two hours before `NOW`. */
const FRESH = "<pubDate>Tue, 27 Oct 2026 06:00:00 GMT</pubDate>";
const parseFeed = (xml: string) => parseAnyFeed(xml, "TechCrunch");

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
      sourceName: "TechCrunch",
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

  it("orders newest first, skips items without a title or an https link, keeps 24", () => {
    // One story an hour over the last 30 hours.
    const many = Array.from({ length: 30 }, (_, i) =>
      item(
        `<title>Story ${i}</title><link>https://techcrunch.com/${i}</link><pubDate>${new Date(
          NOW - (i + 1) * 3_600_000,
        ).toUTCString()}</pubDate>`,
      ),
    );
    const bad = [
      item(`<title></title><link>https://techcrunch.com/x</link>${FRESH}`),
      item(`<title>Insecure</title><link>http://techcrunch.com/y</link>${FRESH}`),
      item(`<title>No link</title>${FRESH}`),
    ];
    const articles = parseFeed(rss([...bad, ...many].join("")));
    expect(articles).toHaveLength(24);
    expect(articles[0]?.title).toBe("Story 0"); // an hour ago
    expect(articles.map((a) => a.pubDate)).toEqual(
      [...articles.map((a) => a.pubDate)].sort().reverse(),
    );
    // A title that looks like a number stays a string.
    expect(
      parseFeed(rss(item(`<title>2026</title><link>https://techcrunch.com/z</link>${FRESH}`)))[0],
    ).toMatchObject({
      title: "2026",
      pubDate: "2026-10-27T06:00:00.000Z",
      snippet: "",
    });
  });

  it("refuses what isn't a feed", () => {
    expect(() => parseFeed("<html><body>Blocked</body></html>")).toThrow("not an RSS or Atom feed");
  });
});

describe("only news: the 48-hour window", () => {
  const story = (title: string, date: string) =>
    item(`<title>${title}</title><link>https://techcrunch.com/${title}</link>${date}`);

  it("drops stories older than 48 hours, and undated ones, before the feed's cap", () => {
    const september = Array.from({ length: 30 }, (_, i) =>
      story(
        `old-${i}`,
        `<pubDate>Mon, ${String((i % 28) + 1).padStart(2, "0")} Sep 2026 10:00:00 +0000</pubDate>`,
      ),
    );
    const read = readFeed(
      rss(
        [
          ...september,
          story("fresh", FRESH),
          story("undated", ""),
          story("garbled", "<pubDate>sometime last week</pubDate>"),
          story("far-future", "<pubDate>Fri, 01 Jan 2049 00:00:00 GMT</pubDate>"),
        ].join(""),
      ),
      "TechCrunch",
    );
    expect(read.articles.map((a) => a.title)).toEqual(["fresh"]);
    expect(read).toMatchObject({ stale: 30, undated: 3 });
  });

  it("keeps a story exactly 48 hours old, not a second older", () => {
    const at = (ms: number) => `<pubDate>${new Date(ms).toUTCString()}</pubDate>`;
    const titles = parseFeed(
      rss(
        story("edge", at(NOW - NEWS_MAX_AGE_MS)) + story("past", at(NOW - NEWS_MAX_AGE_MS - 1000)),
      ),
    ).map((a) => a.title);
    expect(titles).toEqual(["edge"]);
    // A few minutes ahead (a clock running fast) is still news.
    expect(parseFeed(rss(story("soon", at(NOW + 10 * 60_000))))).toHaveLength(1);
  });

  it("measures the window from the time given (the reader's `now`)", () => {
    const xml = rss(MEDIA_ITEM); // 26 Oct 14:05 UTC
    expect(
      readFeed(xml, "TechCrunch", { now: Date.parse("2026-10-28T14:05:00Z") }).articles,
    ).toHaveLength(1);
    expect(readFeed(xml, "TechCrunch", { now: Date.parse("2026-10-28T14:06:00Z") }).stale).toBe(1);
  });

  it("applies to every source before merging, and says what each one dropped", async () => {
    const old = rss(
      story("Last month on AI", "<pubDate>Tue, 29 Sep 2026 09:00:00 +0000</pubDate>") +
        story("AI yesterday", FRESH),
    );
    const read = await readAllSources(feedsFetch({ [TC]: old, [INFOQ]: INFOQ_FEED }));
    expect(read.articles.map((a) => a.title)).toEqual([
      "AI yesterday",
      "Meta Open-Sources a Framework for Agent Evaluation",
    ]);
    expect(read.discarded).toEqual([{ source: "TechCrunch", stale: 1, undated: 0 }]);
    // The same feeds two days later: nothing is news any more.
    const later = await readAllSources(
      feedsFetch({ [TC]: old, [INFOQ]: INFOQ_FEED }),
      NEWS_FEEDS,
      NOW + 3 * 24 * 3_600_000,
    );
    expect(later.articles).toEqual([]);
  });

  it("reads every date format the feeds use", () => {
    const utc = (iso: string) => Date.parse(iso);
    const cases: Array<[string, string | null]> = [
      // RSS (RFC 822 / 2822): TechCrunch, VentureBeat, InfoQ.
      ["Mon, 26 Oct 2026 14:05:00 +0000", "2026-10-26T14:05:00Z"],
      ["Mon, 26 Oct 2026 12:00:00 GMT", "2026-10-26T12:00:00Z"],
      ["Mon, 26 Oct 2026 10:05:00 EDT", "2026-10-26T14:05:00Z"],
      ["Mon, 26 Oct 2026 09:05:00 -0500", "2026-10-26T14:05:00Z"],
      ["Mon, 26 Oct 2026 16:05:00 +02:00", "2026-10-26T14:05:00Z"],
      ["26 Oct 2026 14:05 UT", "2026-10-26T14:05:00Z"], // no weekday, no seconds
      ["Tue, 26 Oct 2026 14:05:00 +0000", "2026-10-26T14:05:00Z"], // the wrong weekday
      ["Monday, 26 October 2026 14:05:00 PST", "2026-10-26T22:05:00Z"],
      ["Mon, 6 Oct 26 14:05:00 GMT", "2026-10-06T14:05:00Z"], // one-digit day, two-digit year
      ["  Mon,  26 Oct 2026\n 14:05:00 +0000 ", "2026-10-26T14:05:00Z"],
      // Atom and dc:date (ISO 8601): The Verge, some RSS.
      ["2026-10-26T15:30:00-04:00", "2026-10-26T19:30:00Z"],
      ["2026-10-26T19:30:00Z", "2026-10-26T19:30:00Z"],
      ["2026-10-26T19:30:00.123+00:00", "2026-10-26T19:30:00Z"],
      ["2026-10-26 19:30:00", "2026-10-26T19:30:00Z"], // no zone: UTC, not the server's
      ["2026-10-26", "2026-10-26T00:00:00Z"],
      // Unreadable.
      ["", null],
      ["yesterday", null],
      ["Mon, 45 Oct 2026 14:05:00 +0000", null],
      ["2026-13-01T00:00:00Z", null],
    ];
    for (const [text, expected] of cases) {
      expect([text, feedTime(text)]).toEqual([text, expected === null ? null : utc(expected)]);
    }
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

// --- The other sources, as their feeds look --------------------------------------------

const TC = "https://techcrunch.com/category/artificial-intelligence/feed/";
const VB = "https://venturebeat.com/category/ai/feed/";
const VB_FALLBACK = "https://feeds.feedburner.com/venturebeat/SZYF";
const VERGE = "https://www.theverge.com/rss/index.xml";
const INFOQ = "https://feed.infoq.com/ai-ml-data-eng/news";

/** VentureBeat: WordPress RSS with the image in an enclosure. */
const VB_FEED = rss(
  item(`<title>Enterprises bet on small language models</title>
  <link>https://venturebeat.com/ai/small-models/?utm_source=rss</link>
  <pubDate>Mon, 26 Oct 2026 16:00:00 +0000</pubDate>
  <description><![CDATA[Smaller models cut inference costs&#8230;]]></description>
  <enclosure url="https://venturebeat.com/wp-content/uploads/slm.jpg" type="image/jpeg" length="0" />`),
);

/** The Verge: Atom, all of tech; the image only inside the HTML content. */
const VERGE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <title type="text">The Verge</title>
  <entry>
    <published>2026-10-26T15:30:00-04:00</published>
    <updated>2026-10-26T15:45:00-04:00</updated>
    <title type="html">Google&#8217;s Gemini comes to Android Auto</title>
    <content type="html">&lt;figure&gt;&lt;img alt="" src="https://platform.theverge.com/wp-content/uploads/gemini.jpg?quality=90" /&gt;&lt;/figure&gt;&lt;p&gt;The assistant can now summarize messages.&lt;/p&gt;</content>
    <link rel="alternate" type="text/html" href="https://www.theverge.com/news/1/gemini-android-auto" />
    <link rel="replies" type="text/html" href="https://www.theverge.com/news/1/gemini-android-auto#comments" />
    <id>https://www.theverge.com/?p=1</id>
    <author><name>Jess Weatherbed</name></author>
  </entry>
  <entry>
    <published>2026-10-26T14:00:00-04:00</published>
    <title type="html">The best mechanical keyboards of the year</title>
    <content type="html">&lt;p&gt;Clicky, thocky and everything in between.&lt;/p&gt;</content>
    <link rel="alternate" type="text/html" href="https://www.theverge.com/23/keyboards" />
    <id>https://www.theverge.com/?p=2</id>
  </entry>
</feed>`;

/** InfoQ: RSS with no image at all and a category per topic. */
const INFOQ_FEED = rss(
  item(`<title>Meta Open-Sources a Framework for Agent Evaluation</title>
  <link>https://www.infoq.com/news/2026/10/meta-agent-eval/</link>
  <pubDate>Mon, 26 Oct 2026 12:00:00 GMT</pubDate>
  <category>AI, ML &amp; Data Engineering</category>
  <description>&lt;p&gt;Meta released a framework to evaluate agents.&lt;/p&gt;</description>`),
);

const xml = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } });

/** A fetch that answers each feed address from `feeds` (a missing one is a 404). */
function feedsFetch(feeds: Record<string, string | Error>) {
  return vi.fn(async (url: string | URL | Request) => {
    const body = feeds[String(url)];
    if (body instanceof Error) throw body;
    return body === undefined ? new Response("missing", { status: 404 }) : xml(body);
  });
}

const allFeeds = () =>
  feedsFetch({ [TC]: rss(MEDIA_ITEM), [VB]: VB_FEED, [VERGE]: VERGE_FEED, [INFOQ]: INFOQ_FEED });

describe("each source's feed", () => {
  it("reads VentureBeat's enclosure image and The Verge's Atom entries", () => {
    expect(parseAnyFeed(VB_FEED, "VentureBeat")[0]).toMatchObject({
      title: "Enterprises bet on small language models",
      imageUrl: "https://venturebeat.com/wp-content/uploads/slm.jpg",
      snippet: "Smaller models cut inference costs…",
      sourceName: "VentureBeat",
    });
    const verge = parseAnyFeed(VERGE_FEED, "The Verge");
    expect(verge[0]).toEqual({
      title: "Google’s Gemini comes to Android Auto",
      link: "https://www.theverge.com/news/1/gemini-android-auto",
      snippet: "The assistant can now summarize messages.",
      pubDate: "2026-10-26T19:30:00.000Z",
      imageUrl: "https://platform.theverge.com/wp-content/uploads/gemini.jpg?quality=90",
      sourceName: "The Verge",
    });
    expect(verge).toHaveLength(2);
  });

  it("keeps only the AI stories of a general feed", () => {
    const verge = parseAnyFeed(VERGE_FEED, "The Verge", { general: true });
    expect(verge.map((a) => a.title)).toEqual(["Google’s Gemini comes to Android Auto"]);
    expect(isAboutAi({ title: "OpenAI raises again", snippet: "", categories: [] })).toBe(true);
    expect(isAboutAi({ title: "New phone", snippet: "", categories: ["AI"] })).toBe(true);
    expect(isAboutAi({ title: "Said in an aid", snippet: "Mail and email", categories: [] })).toBe(
      false,
    );
  });

  it("leaves the image empty when a feed has none (InfoQ)", () => {
    expect(parseAnyFeed(INFOQ_FEED, "InfoQ")[0]).toMatchObject({
      title: "Meta Open-Sources a Framework for Agent Evaluation",
      snippet: "Meta released a framework to evaluate agents.",
      imageUrl: null,
      sourceName: "InfoQ",
    });
  });

  it("survives malformed XML: broken items are skipped, a cut-off feed keeps what arrived", () => {
    // A stray ampersand or an unclosed tag inside an item doesn't cost the other items.
    const messy = rss(
      item(`<title>Good one</title><link>https://example.com/good</link>${FRESH}`) +
        item(`<title>Bad & unescaped <b>title</title><link>not a url</link>${FRESH}`),
    );
    expect(parseAnyFeed(messy, "X").map((a) => a.title)).toEqual(["Good one"]);
    // A download cut short: the complete stories are still there.
    const cut =
      `<rss><channel><item><title>A</title><link>https://a.example/1</link>${FRESH}</item>` +
      `<item><title>B</title><link>https://a.example/2</link>${FRESH}`;
    expect(parseAnyFeed(cut, "X").map((a) => a.title)).toEqual(["A", "B"]);
    expect(parseAnyFeed("<rss><channel><item><title>x", "X")).toEqual([]);
    // Not a feed at all.
    expect(() => parseAnyFeed("", "X")).toThrow("not an RSS or Atom feed");
    expect(() => parseAnyFeed('{"json":true}', "X")).toThrow("not an RSS or Atom feed");
  });
});

describe("merging the sources", () => {
  const article = (
    title: string,
    sourceName: string,
    pubDate: string,
    link = `https://x.example/${title}`,
  ) => ({
    title,
    link,
    snippet: "",
    pubDate,
    imageUrl: null,
    sourceName,
  });

  it("orders every source's stories together, newest first", () => {
    const merged = mergeArticles([
      [article("a", "One", "2026-10-26T10:00:00Z")],
      [article("b", "Two", "2026-10-26T12:00:00Z"), article("c", "Two", "2026-10-25T09:00:00Z")],
    ]);
    expect(merged.map((a) => a.title)).toEqual(["b", "a", "c"]);
  });

  it("drops the same story from a second source, by link or by title", () => {
    const merged = mergeArticles([
      [article("Big news", "One", "2026-10-26T10:00:00Z", "https://www.site.example/p/?utm=1")],
      [
        article("Other title", "Two", "2026-10-26T09:00:00Z", "https://site.example/p#top"),
        article("BIG NEWS!", "Two", "2026-10-26T08:00:00Z", "https://elsewhere.example/q"),
      ],
    ]);
    expect(merged.map((a) => a.title)).toEqual(["Big news"]);
  });

  it("caps each source at 8 and the list at 24", () => {
    const busy = Array.from({ length: 20 }, (_, i) =>
      article(`busy ${i}`, "Busy", `2026-10-26T${String(i).padStart(2, "0")}:00:00Z`),
    );
    const quiet = Array.from({ length: 20 }, (_, i) =>
      article(`quiet ${i}`, "Quiet", `2026-10-01T${String(i).padStart(2, "0")}:00:00Z`),
    );
    const others = Array.from({ length: 20 }, (_, i) =>
      article(`other ${i}`, "Other", `2026-09-01T${String(i).padStart(2, "0")}:00:00Z`),
    );
    const extra = Array.from({ length: 20 }, (_, i) =>
      article(`extra ${i}`, "Extra", `2026-08-01T${String(i).padStart(2, "0")}:00:00Z`),
    );
    const merged = mergeArticles([busy, quiet, others, extra]);
    expect(merged).toHaveLength(24);
    expect(merged.filter((a) => a.sourceName === "Busy")).toHaveLength(8);
    expect(merged.filter((a) => a.sourceName === "Extra")).toHaveLength(0);
  });
});

describe("readAllSources", () => {
  it("reads every source at once and marks each story with its publisher", async () => {
    const fetchMock = allFeeds();
    const read = await readAllSources(fetchMock);
    expect(read.sources).toEqual(["TechCrunch", "VentureBeat", "The Verge", "InfoQ"]);
    expect(read.failed).toEqual([]);
    expect(read.articles.map((a) => a.sourceName)).toEqual([
      "The Verge", // 19:30 UTC
      "VentureBeat", // 16:00
      "TechCrunch", // 14:05
      "InfoQ", // 12:00
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The Verge's keyboard roundup isn't AI news.
    expect(read.articles.some((a) => a.title.includes("keyboards"))).toBe(false);
  });

  it("leaves out a source that's down or answers garbage, and says which", async () => {
    const read = await readAllSources(
      feedsFetch({
        [TC]: rss(MEDIA_ITEM),
        [VB]: "<html>Cloudflare</html>",
        [VB_FALLBACK]: new Error("ECONNRESET"),
        [VERGE]: new Error("timeout"),
        [INFOQ]: INFOQ_FEED,
      }),
    );
    expect(read.sources).toEqual(["TechCrunch", "InfoQ"]);
    expect(read.failed).toEqual([
      { source: "VentureBeat", error: "ECONNRESET" },
      { source: "The Verge", error: "timeout" },
    ]);
    expect(read.articles).toHaveLength(2);
  });

  it("tries VentureBeat's second address, keeping only its AI stories", async () => {
    const general = rss(
      item(
        `<title>Anthropic ships Claude for Excel</title><link>https://venturebeat.com/ai/x</link>${FRESH}`,
      ) +
        item(
          `<title>The best gaming laptops</title><link>https://venturebeat.com/games/y</link>${FRESH}`,
        ),
    );
    const read = await readAllSources(
      feedsFetch({ [VB]: new Error("down"), [VB_FALLBACK]: general }),
    );
    expect(read.sources).toEqual(["VentureBeat"]);
    expect(read.articles.map((a) => a.title)).toEqual(["Anthropic ships Claude for Excel"]);
  });

  it("throws when no source can be read", async () => {
    await expect(readAllSources(feedsFetch({}))).rejects.toThrow("feed answered 404");
  });
});

describe("getNews (the warm container's copy)", () => {
  beforeEach(() => resetNewsCache());

  it("reads every feed once per 30 minutes", async () => {
    const fetchMock = allFeeds();
    const t0 = NOW;
    const first = await getNews(fetchMock, t0);
    expect(first).toMatchObject({ fromCache: false, expiresAt: t0 + 1_800_000, failed: [] });
    expect(first.response).toMatchObject({
      source: "TechCrunch, VentureBeat, The Verge, InfoQ",
      fetchedAt: t0,
    });
    expect(first.response.articles).toHaveLength(4);
    expect((await getNews(fetchMock, t0 + 29 * 60_000)).fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]).toEqual([TC, expect.objectContaining({ redirect: "follow" })]);
    await getNews(fetchMock, t0 + 30 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("keeps a list missing a source only 5 minutes", async () => {
    const t0 = NOW;
    const partial = await getNews(feedsFetch({ [TC]: rss(MEDIA_ITEM) }), t0);
    expect(partial.expiresAt).toBe(t0 + RETRY_PARTIAL_MS);
    expect(partial.response.source).toBe("TechCrunch");
    expect(partial.failed?.map((f) => f.source)).toEqual(["VentureBeat", "The Verge", "InfoQ"]);
  });

  it("serves the last good list, marked stale, when every feed fails; tries again a minute later", async () => {
    const t0 = NOW;
    await getNews(allFeeds(), t0);
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    const later = t0 + 31 * 60_000;
    const stale = await getNews(down, later);
    expect(stale.response.stale).toBe(true);
    expect(stale.response.articles).toHaveLength(4);
    expect(stale.expiresAt).toBe(later + RETRY_AFTER_FAILURE_MS);
    const calls = down.mock.calls.length;
    await getNews(down, later + 30_000); // within the minute: no new attempt
    expect(down).toHaveBeenCalledTimes(calls);
  });

  it("drops stories from the kept list as they age past 48 hours", async () => {
    await getNews(allFeeds(), NOW); // the stories of 26 Oct, 12:00 to 19:30 UTC
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    const stale = await getNews(down, Date.parse("2026-10-28T15:00:00Z"));
    expect(stale.response.stale).toBe(true);
    // TechCrunch (14:05) and InfoQ (12:00) are now more than 48 hours old.
    expect(stale.response.articles.map((a) => a.sourceName)).toEqual(["The Verge", "VentureBeat"]);
  });

  it("throws when every feed fails and nothing was ever read, or they answer with something else", async () => {
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
  const event = (routeKey = "GET /news", groups?: string[], refresh = false): HttpEvent =>
    ({
      version: "2.0",
      routeKey,
      rawPath: "/news",
      rawQueryString: refresh ? "refresh=1" : "",
      ...(refresh && { queryStringParameters: { refresh: "1" } }),
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
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  it("answers the articles with a browser cache for what's left of the 30 minutes", async () => {
    vi.stubGlobal("fetch", allFeeds());
    const first = await call(event());
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=1800, stale-while-revalidate=600");
    expect(
      JSON.parse(first.body).articles.map((a: { sourceName: string }) => a.sourceName),
    ).toEqual(["The Verge", "VentureBeat", "TechCrunch", "InfoQ"]);

    vi.setSystemTime(NOW + 10 * 60_000);
    const second = await call(event());
    expect(second.headers["cache-control"]).toBe(
      "public, max-age=1200, stale-while-revalidate=600",
    );
    vi.unstubAllGlobals();
  });

  it("?refresh=1 reads the feed again, uncached by the browser, at most once a minute", async () => {
    const fetchImpl = allFeeds();
    vi.stubGlobal("fetch", fetchImpl);
    vi.setSystemTime(NOW);
    await call(event());
    vi.setSystemTime(NOW + 30_000);
    const soon = await call(event("GET /news", undefined, true));
    expect(soon.headers["cache-control"]).toBe("no-store");
    expect(fetchImpl).toHaveBeenCalledTimes(4); // read 30 s ago: served from memory
    vi.setSystemTime(NOW + 90_000);
    const later = await call(event("GET /news", undefined, true));
    expect(later.headers["cache-control"]).toBe("no-store");
    expect(fetchImpl).toHaveBeenCalledTimes(8); // the fresh read
    expect(JSON.parse(later.body).fetchedAt).toBe(NOW + 90_000);
    // A plain request afterwards is the refreshed copy, cached for a full 30 minutes again.
    const plain = await call(event());
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(plain.headers["cache-control"]).toBe("public, max-age=1800, stale-while-revalidate=600");
    vi.unstubAllGlobals();
  });

  it("502 when no feed can be read and there's nothing cached; guests and other routes refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ENOTFOUND"))),
    );
    const failed = await call(event());
    expect(failed.statusCode).toBe(502);
    expect(JSON.parse(failed.body).message).toMatch(/news sources/);
    expect((await call(event("GET /news", ["guests"]))).statusCode).toBe(403);
    expect((await call(event("POST /news"))).statusCode).toBe(404);
    vi.unstubAllGlobals();
  });
});
