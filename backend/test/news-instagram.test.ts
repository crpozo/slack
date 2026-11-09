import type Anthropic from "@anthropic-ai/sdk";
import { NEWS_FEEDS, newsSourceBadge } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captionLines,
  configuredFeeds,
  feedAddresses,
  instagramPost,
  promptSourceTag,
  readAllSources,
  readFeed,
  resetCoverCache,
} from "../src/lib/news";
import { chatStoriesText, NEWS_CHAT_SYSTEM } from "../src/lib/newsChat";
import {
  articlesText,
  INSIGHTS_MODEL,
  INSIGHTS_SYSTEM,
  insightsFrom,
  insightsRequest,
} from "../src/lib/newsInsights";

// Phase 57: @evolving.ai on Instagram, read through an RSS bridge (Meta blocks
// AWS Lambda's addresses). The fixtures are what RSS-Bridge-style services
// return: no headline, the photo as an <img> inside a link, then the caption
// line by line, ending in a block of hashtags.

const NOW = Date.parse("2026-10-27T08:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  resetCoverCache();
});
afterEach(() => {
  vi.useRealTimers();
});

const IG = "Evolving AI (Instagram)";
const BRIDGE =
  "https://rss-bridge.example.com/?action=display&bridge=InstagramBridge&u=evolving.ai";
const PHOTO =
  "https://scontent-mia3-1.cdninstagram.com/v/t51.29350-15/465_n.jpg?stp=dst-jpg_e35&_nc_ht=scontent-mia3-1.cdninstagram.com&oe=6735F1A2";

/** A post: `<img>` first (its URL HTML-escaped), the caption, hashtags at the end. */
const GPT6_HTML =
  `<a href="https://www.instagram.com/p/DBx1/"><img src="${PHOTO.replaceAll("&", "&amp;")}" alt="Photo by Evolving AI"></a><br>` +
  "🚨 OpenAI just dropped GPT-6 and it&#39;s INSANE 🤯🔥<br><br>" +
  "The new model scores 92% on SWE-bench Verified and costs $2 per million input tokens. " +
  "It&#8217;s available today in the API &amp; ChatGPT Plus.<br><br>" +
  "Would you switch from Claude? 👇 Follow @evolving.ai for daily AI news 🚀<br>.<br>.<br>.<br>" +
  "#ai #openai #gpt6 #chatgpt #artificialintelligence #machinelearning #tech #inteligenciaartificial";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>evolving.ai - Instagram Bridge</title><link>https://www.instagram.com/evolving.ai/</link>
<item>
  <title>🚨 OpenAI just dropped GPT-6 and it's INSANE 🤯🔥 The new model scores 92% on…</title>
  <link>https://www.instagram.com/p/DBx1/</link>
  <pubDate>Tue, 27 Oct 2026 05:30:00 +0000</pubDate>
  <description><![CDATA[${GPT6_HTML}]]></description>
</item>
<item>
  <title>evolving.ai</title>
  <link>https://www.instagram.com/p/DBx2/</link>
  <pubDate>Mon, 26 Oct 2026 22:10:00 +0000</pubDate>
  <content:encoded><![CDATA[<p><img src="http://insecure.example.com/x.jpg"><img src="https://scontent.cdninstagram.com/v/second.jpg"></p>
  <p>Google DeepMind unveils Genie 4: real-time playable 3D worlds from a single prompt 🎮</p>
  <p>Rolling out to researchers first. #google #deepmind #genie4 #gamedev</p>]]></content:encoded>
</item>
<item>
  <title>Instagram post by evolving.ai</title>
  <link>https://www.instagram.com/p/DBx3/</link>
  <pubDate>Mon, 26 Oct 2026 18:00:00 +0000</pubDate>
  <description><![CDATA[<img src="data:image/gif;base64,R0lGOD"> Microsoft adds C# agents to Copilot Studio 🤖 #microsoft #copilot]]></description>
</item>
<item>
  <title>evolving.ai</title>
  <link>https://www.instagram.com/p/DBx4/</link>
  <pubDate>Mon, 26 Oct 2026 17:00:00 +0000</pubDate>
  <description><![CDATA[<img src="https://scontent.cdninstagram.com/v/tags.jpg"> #ai #tech #future]]></description>
</item>
</channel></rss>`;

describe("instagramPost: the photo and the caption out of a post's HTML", () => {
  it("takes the first https <img> (entities decoded) and the caption without tags or hashtags", () => {
    const post = instagramPost(GPT6_HTML);
    expect(post.imageUrl).toBe(PHOTO);
    expect(post.title).toBe("🚨 OpenAI just dropped GPT-6 and it's INSANE 🤯🔥");
    expect(post.caption).toBe(
      "🚨 OpenAI just dropped GPT-6 and it's INSANE 🤯🔥 " +
        "The new model scores 92% on SWE-bench Verified and costs $2 per million input tokens. " +
        "It’s available today in the API & ChatGPT Plus. " +
        "Would you switch from Claude? 👇 Follow @evolving.ai for daily AI news 🚀",
    );
    expect(post.caption).not.toMatch(/#|<|&amp;|&#/);
  });

  it("skips images that aren't https (http, data:) and keeps C# and other non-tags", () => {
    expect(
      instagramPost('<img src="http://a.example/x.jpg"><img src="https://b.example/y.jpg">')
        .imageUrl,
    ).toBe("https://b.example/y.jpg");
    expect(instagramPost('<img src="data:image/gif;base64,R0">text').imageUrl).toBeNull();
    expect(captionLines("C# and F# agents, #1 on SWE-bench 🏆 #dev #ai #2026trends")).toEqual([
      "C# and F# agents, #1 on SWE-bench 🏆",
    ]);
  });

  it("drops the filler lines that push hashtags down and lines left empty", () => {
    expect(captionLines("Big news<br>.<br>•<br>-<br>#a #b<br>Second line")).toEqual([
      "Big news",
      "Second line",
    ]);
  });
});

describe("an Instagram feed read as stories", () => {
  const read = () => readFeed(FEED, IG, { now: NOW, platform: "instagram" }).articles;

  it("gives each post a headline, a clean snippet and its photo", () => {
    const [gpt6, genie, copilot] = read();
    expect(gpt6).toEqual({
      // The bridge's title was the caption cut short: its first line reads better.
      title: "🚨 OpenAI just dropped GPT-6 and it's INSANE 🤯🔥",
      link: "https://www.instagram.com/p/DBx1/",
      snippet: expect.stringMatching(/^🚨 OpenAI just dropped GPT-6 .* SWE-bench Verified .*…$/),
      pubDate: "2026-10-27T05:30:00.000Z",
      imageUrl: PHOTO,
      sourceName: IG,
    });
    expect(gpt6!.snippet).not.toContain("#");
    // The handle as a title is no headline; content:encoded's first https image is the photo.
    expect(genie).toMatchObject({
      title:
        "Google DeepMind unveils Genie 4: real-time playable 3D worlds from a single prompt 🎮",
      snippet:
        "Google DeepMind unveils Genie 4: real-time playable 3D worlds from a single prompt 🎮 Rolling out to researchers first.",
      imageUrl: "https://scontent.cdninstagram.com/v/second.jpg",
    });
    expect(copilot).toMatchObject({
      title: "Microsoft adds C# agents to Copilot Studio 🤖",
      imageUrl: null, // a data: image is no image
    });
  });

  it("leaves out a post that is nothing but hashtags", () => {
    expect(read().map((a) => a.link)).not.toContain("https://www.instagram.com/p/DBx4/");
    expect(read()).toHaveLength(3);
  });

  it("reads a publisher's feed as before when it isn't Instagram", () => {
    // Without the platform the bridge's titles are kept as they are.
    expect(readFeed(FEED, "Other", { now: NOW }).articles[1]!.title).toBe("evolving.ai");
  });
});

describe("the source: configured by IG_EVOLVING_RSS_URL", () => {
  const instagram = NEWS_FEEDS.find((f) => f.platform === "instagram")!;

  it("is 'Evolving AI (Instagram)', with an Evolving AI · Instagram badge", () => {
    expect(instagram).toMatchObject({ name: IG, urlEnv: "IG_EVOLVING_RSS_URL" });
    expect(newsSourceBadge(IG)).toEqual({ label: "Evolving AI", platform: "instagram" });
    expect(newsSourceBadge("TechCrunch")).toEqual({ label: "TechCrunch", platform: undefined });
  });

  it("reads its address from the environment, and only an https one", () => {
    expect(feedAddresses(instagram, { IG_EVOLVING_RSS_URL: BRIDGE })).toEqual([{ url: BRIDGE }]);
    expect(feedAddresses(instagram, { IG_EVOLVING_RSS_URL: "http://bridge.example/x" })).toEqual(
      [],
    );
    expect(feedAddresses(instagram, {})).toEqual([]);
    expect(configuredFeeds(NEWS_FEEDS, {}).map((f) => f.name)).not.toContain(IG);
  });

  const respond = (body: string) =>
    new Response(body, { headers: { "content-type": "application/rss+xml" } });

  it("joins the other sources when set, and never asks Instagram's pages for a cover", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url) === BRIDGE ? respond(FEED) : new Response("down", { status: 503 }),
    );
    const read = await readAllSources(fetchMock, NEWS_FEEDS, NOW, {
      IG_EVOLVING_RSS_URL: BRIDGE,
    });
    expect(read.sources).toEqual([IG]);
    expect(read.articles.map((a) => a.sourceName)).toEqual([IG, IG, IG]);
    // The post with no photo kept the fallback: no request went to instagram.com.
    const asked = fetchMock.mock.calls.map(([url]) => String(url));
    expect(asked.filter((u) => u.includes("instagram.com"))).toEqual([]);
  });

  it("is left out, not reported as down, while the variable is unset", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) => new Response("down", { status: 503 }),
    );
    await expect(readAllSources(fetchMock, NEWS_FEEDS, NOW, {})).rejects.toThrow();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(BRIDGE);
    const tc = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("techcrunch")
        ? respond(FEED.replaceAll("instagram.com/p", "techcrunch.com/2026"))
        : new Response("down", { status: 503 }),
    );
    const read = await readAllSources(tc, NEWS_FEEDS, NOW, {});
    expect(read.failed.map((f) => f.source)).not.toContain(IG);
  });
});

describe("Claude Haiku and the captions", () => {
  const posts = () => readFeed(FEED, IG, { now: NOW, platform: "instagram" }).articles;
  const publisher = {
    title: "OpenAI launches GPT-6",
    link: "https://techcrunch.com/2026/10/27/gpt-6/",
    snippet: "OpenAI released GPT-6 on Tuesday.",
    pubDate: "2026-10-27T06:00:00.000Z",
    imageUrl: null,
    sourceName: "TechCrunch",
  };

  it("tells the model what an Instagram caption is and to keep the same professional JSON", () => {
    for (const rule of [
      /Instagram captions/,
      /emojis/,
      /hashtags/,
      /Ignore the hashtags completely/,
      /same professional tone and JSON format/,
    ]) {
      expect(INSIGHTS_SYSTEM).toMatch(rule);
    }
    const request = insightsRequest([publisher, ...posts()], "2026-10-27");
    expect(request.system).toBe(INSIGHTS_SYSTEM);
    // Same schema for every source: the dashboard's JSON doesn't change.
    expect(request.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(NEWS_CHAT_SYSTEM).toMatch(/Instagram caption/);
  });

  it("marks each post as a caption in the story list, with no hashtag in it", () => {
    const text = articlesText([publisher, ...posts()]);
    expect(text).toContain("1. [TechCrunch] OpenAI launches GPT-6");
    expect(text).toContain(
      "2. [Evolving AI (Instagram) · Instagram caption] 🚨 OpenAI just dropped GPT-6",
    );
    expect(text).not.toMatch(/#(?:ai|openai|gpt6|google)\b/);
    expect(chatStoriesText(posts())).toContain("[Evolving AI (Instagram) · Instagram caption]");
    expect(promptSourceTag("InfoQ")).toBe("InfoQ");
  });

  it("joins the model's professional pick of a caption to the post: link, photo, source", () => {
    const articles = [publisher, ...posts()];
    const dashboard = {
      stories: [
        {
          story: 3,
          headline: "Google DeepMind presenta Genie 4, mundos 3D jugables en tiempo real",
          summary:
            "Genera entornos 3D interactivos desde una sola instrucción; llega primero a investigadores.",
          whyItMatters: "Abre la puerta a prototipos de simulación sin motores de juego.",
        },
      ],
      deepDive: { story: 3, context: "Contexto.", implications: ["a"], questions: ["b"] },
      trends: [{ topic: "Mundos 3D", text: "Los **modelos de mundo** avanzan.", stories: [3] }],
      takeaways: [
        { lead: "Explorar simulación", body: "para demos de clientes.", horizon: "vigilar" },
      ],
      watchlist: [],
    };
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: INSIGHTS_MODEL,
      content: [{ type: "text", text: JSON.stringify(dashboard) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 300, output_tokens: 120 },
    } as unknown as Anthropic.Message;
    const outcome = insightsFrom(message, articles);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.dashboard.stories[0]).toEqual({
      headline: dashboard.stories[0]!.headline,
      summary: dashboard.stories[0]!.summary,
      whyItMatters: dashboard.stories[0]!.whyItMatters,
      sourceName: IG,
      link: "https://www.instagram.com/p/DBx2/",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/second.jpg",
      pubDate: "2026-10-26T22:10:00.000Z",
    });
    expect(outcome.dashboard.trends[0]!.evidence).toEqual([
      expect.objectContaining({ sourceName: IG, link: "https://www.instagram.com/p/DBx2/" }),
    ]);
  });
});
