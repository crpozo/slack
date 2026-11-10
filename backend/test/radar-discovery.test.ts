import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type Anthropic from "@anthropic-ai/sdk";
import { blipKey, type RadarBlip, type RadarProposal } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handler as discover,
  useDiscoveryFetch,
  useDiscoveryModel,
} from "../src/handlers/radar-discovery-engine";
import { BLIP_PK, PROPOSAL_PK, SCAN_PK } from "../src/lib/radar";
import {
  DISCOVERY_MAX_PROPOSALS,
  DISCOVERY_SYSTEM,
  discoveriesFrom,
  discoveryRequest,
  HN_API,
  HN_TOP_STORIES,
  hackerNewsTop,
  type DiscoverySignal,
} from "../src/lib/radarDiscovery";
import { ddbMock, resetMocks } from "./helpers";

const RADAR = "slack-test-tech-radar";
const NEWS = "slack-test-news-insights";
const NOW = Date.parse("2026-11-10T06:00:00Z");

// --- the tech-radar table in memory, and the stored AI news ----------------------------

let table: Map<string, Record<string, unknown>>;
let newsRows: Array<Record<string, unknown>>;
const keyOf = (k: { pk: unknown; id: unknown }) => `${String(k.pk)}\n${String(k.id)}`;
const rows = (pk: string) => [...table.values()].filter((r) => r.pk === pk);

function fakeTables() {
  table = new Map();
  newsRows = [];
  ddbMock.on(PutCommand).callsFake((input) => {
    const item = input.Item as { pk: string; id: string };
    if (input.ConditionExpression?.includes("attribute_not_exists") && table.has(keyOf(item))) {
      throw new ConditionalCheckFailedException({ message: "exists", $metadata: {} });
    }
    table.set(keyOf(item), item);
    return {};
  });
  ddbMock.on(GetCommand).callsFake((input) => ({ Item: table.get(keyOf(input.Key)) }));
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues ?? {};
    if (input.TableName === NEWS) {
      return {
        Items: newsRows.filter(
          (r) => r.feed === values[":feed"] && String(r.day) >= values[":since"],
        ),
      };
    }
    return { Items: [...table.values()].filter((r) => r.pk === values[":pk"]) };
  });
}

const blip = (name: string, quadrant: RadarBlip["quadrant"] = "Frameworks"): RadarBlip => ({
  id: blipKey(name),
  name,
  quadrant,
  ring: "Trial",
  description: "",
  previousRing: null,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: "u",
});
const putBlip = (b: RadarBlip) =>
  table.set(keyOf({ pk: BLIP_PK, id: b.id }), { pk: BLIP_PK, ...b });
const putRow = (p: RadarProposal) =>
  table.set(keyOf({ pk: PROPOSAL_PK, id: p.id }), { pk: PROPOSAL_PK, ...p });

// --- Hacker News, mocked ------------------------------------------------------------------

type HnItem = {
  id: number;
  type: string;
  title?: string;
  url?: string;
  score?: number;
  dead?: boolean;
};
const HN_ITEMS: HnItem[] = [
  {
    id: 1,
    type: "story",
    title: "Show HN: Quill, a Rust bundler for TypeScript",
    url: "https://quill.dev",
    score: 512,
  },
  {
    id: 2,
    type: "story",
    title: "LangChain v1.0 is out",
    url: "https://blog.langchain.dev/v1",
    score: 300,
  },
  { id: 3, type: "job", title: "Acme is hiring" },
  { id: 4, type: "story", title: "Flagged story", dead: true },
  { id: 5, type: "story", title: "Ask HN: What are you working on?", score: 90 },
  { id: 6, type: "story", title: "Plain-http link", url: "http://insecure.example", score: 10 },
];

/** A fetch for the Hacker News API: the top list, then each item (id 7 fails). */
function hackerNews(items: HnItem[] = HN_ITEMS, extraIds: number[] = [7]) {
  const ids = [...items.map((i) => i.id), ...extraIds];
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href === `${HN_API}/topstories.json`) return Response.json(ids);
    const id = Number(/item\/(\d+)\.json$/.exec(href)?.[1]);
    const item = items.find((i) => i.id === id);
    if (!item) return new Response("nope", { status: 500 });
    return Response.json(item);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const answer = (json: unknown): Anthropic.Message =>
  ({
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 80 },
  }) as unknown as Anthropic.Message;

beforeEach(() => {
  resetMocks();
  process.env.TECH_RADAR_TABLE = RADAR;
  process.env.NEWS_INSIGHTS_TABLE = NEWS;
  fakeTables();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  useDiscoveryModel(null);
  useDiscoveryFetch(null);
  vi.useRealTimers();
});

describe("Hacker News, the sensor", () => {
  it("reads the top stories: real stories only, https links or the thread", async () => {
    const fetchImpl = hackerNews();
    const signals = await hackerNewsTop(fetchImpl);
    expect(signals).toEqual([
      { source: "hackernews", title: HN_ITEMS[0]!.title, link: "https://quill.dev", points: 512 },
      {
        source: "hackernews",
        title: "LangChain v1.0 is out",
        link: "https://blog.langchain.dev/v1",
        points: 300,
      },
      {
        source: "hackernews",
        title: "Ask HN: What are you working on?",
        link: "https://news.ycombinator.com/item?id=5",
        points: 90,
      },
      {
        source: "hackernews",
        title: "Plain-http link",
        link: "https://news.ycombinator.com/item?id=6",
        points: 10,
      },
    ]);
  });

  it("reads at most the top 30", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      type: "story",
      title: `Story ${i}`,
      score: i,
    }));
    const fetchImpl = hackerNews(many, []);
    expect(await hackerNewsTop(fetchImpl)).toHaveLength(HN_TOP_STORIES);
    // The list, then one request per story read.
    expect(fetchImpl).toHaveBeenCalledTimes(HN_TOP_STORIES + 1);
  });

  it("fails when the list itself can't be read", async () => {
    const down = vi.fn(
      async () => new Response("down", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(hackerNewsTop(down)).rejects.toThrow(/503/);
  });
});

describe("the request to Haiku", () => {
  it("sends the strict prompt, what the radar knows, and the numbered headlines", () => {
    const signals: DiscoverySignal[] = [
      {
        source: "news",
        title: "Acme ships Zeta-9",
        summary: "Un modelo nuevo.",
        link: "https://a/1",
      },
      { source: "hackernews", title: "Show HN: Quill", link: "https://quill.dev", points: 512 },
    ];
    const req = discoveryRequest(signals, ["LangChain"], "2026-11-10");
    expect(req.model).toBe("us.anthropic.claude-haiku-5-5");
    expect(req.system).toBe(DISCOVERY_SYSTEM);
    expect(DISCOVERY_SYSTEM).toContain(
      "Analyze this daily tech data. Extract only NEW or trending AI models, software frameworks, developer tools, or infrastructure. Ignore corporate news or gossip.",
    );
    expect(req.output_config?.format).toMatchObject({ type: "json_schema" });
    const prompt = String(req.messages[0]?.content);
    expect(prompt).toContain("<known>\nLangChain\n</known>");
    expect(prompt).toContain("[1] (AI news) Acme ships Zeta-9 — Un modelo nuevo.");
    expect(prompt).toContain("[2] (Hacker News, 512 points) Show HN: Quill");
  });

  it("keeps only what the radar doesn't know by a similar name, valid as a blip, capped", () => {
    const signals: DiscoverySignal[] = [
      { source: "hackernews", title: "Quill", link: "https://quill.dev", points: 5 },
    ];
    const names = [
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo",
      "Foxtrot",
      "Golf",
      "Hotel",
      "India",
      "Juliet",
      "Kilo",
    ];
    expect(names).toHaveLength(DISCOVERY_MAX_PROPOSALS + 3);
    const many = names.map((name) => ({
      name,
      quadrant: "DevTools",
      description: "A tool.",
      signal: 9,
    }));
    const outcome = discoveriesFrom(
      answer({
        technologies: [
          { name: "Quill", quadrant: "DevTools", description: "A Rust bundler.", signal: 1 },
          { name: "LangChain 1.0", quadrant: "Frameworks", description: "dup", signal: 1 },
          { name: "quill", quadrant: "DevTools", description: "dup in the answer", signal: 1 },
          { name: "Bad\u0007Name", quadrant: "DevTools", description: "control char", signal: 1 },
          ...many,
        ],
      }),
      signals,
      ["LangChain"],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.found[0]).toEqual({
      name: "Quill",
      quadrant: "DevTools",
      description: "A Rust bundler.",
      signal: signals[0],
    });
    expect(outcome.found).toHaveLength(DISCOVERY_MAX_PROPOSALS);
    expect(outcome.skipped).toBe(3 + 4);
    expect(discoveriesFrom(answer("not json"), signals, [])).toMatchObject({ ok: false });
  });
});

describe("the Discovery Engine Lambda", () => {
  const technologies = {
    technologies: [
      {
        name: "Quill",
        quadrant: "DevTools",
        description: "A Rust-based bundler for TypeScript projects.",
        signal: 3,
      },
      {
        name: "Zeta-9",
        quadrant: "Models",
        description: "Acme's new open-weights model.",
        signal: 1,
      },
      {
        name: "Lang Chain",
        quadrant: "Frameworks",
        description: "Already on the radar.",
        signal: 4,
      },
      {
        name: "Old Rejected Thing",
        quadrant: "Infrastructure",
        description: "Rejected.",
        signal: 3,
      },
    ],
  };

  beforeEach(() => {
    putBlip(blip("LangChain"));
    putRow({
      id: "old",
      kind: "add",
      name: "Old Rejected Thing",
      quadrant: "Infrastructure",
      ring: "Assess",
      rationale: "",
      status: "dismissed",
      createdAt: 1,
    });
    // Yesterday's morning analysis (19 hours ago) and one from three days ago.
    newsRows.push(
      {
        feed: "techcrunch-ai",
        day: "2026-11-09",
        generatedAt: NOW - 19 * 60 * 60 * 1000,
        stories: [
          { headline: "Acme lanza Zeta-9", summary: "Un modelo abierto.", link: "https://a/1" },
        ],
        articles: [
          { title: "Acme releases Zeta-9", link: "https://a/1" },
          { title: "A funding round", link: "https://a/2" },
        ],
      },
      {
        feed: "techcrunch-ai",
        day: "2026-11-07",
        generatedAt: NOW - 3 * 24 * 60 * 60 * 1000,
        stories: [],
        articles: [{ title: "Too old", link: "https://a/old" }],
      },
    );
  });

  it("reads the last day's AI news and Hacker News, asks Haiku, and files the new ones as pending", async () => {
    const create = vi.fn().mockResolvedValue(answer(technologies));
    useDiscoveryModel({ create });
    useDiscoveryFetch(hackerNews());

    const run = await discover();
    expect(run).toEqual({
      day: "2026-11-10",
      newsStories: 2,
      hackerNewsStories: 4,
      proposed: ["Quill", "Zeta-9"],
      skipped: 2,
      inputTokens: 1200,
      outputTokens: 80,
    });
    const prompt = String(create.mock.calls[0]![0].messages[0].content);
    expect(prompt).toContain("[1] (AI news) Acme releases Zeta-9 — Un modelo abierto.");
    expect(prompt).not.toContain("Too old");
    expect(prompt).toContain("[3] (Hacker News, 512 points) Show HN: Quill");
    expect(prompt).toMatch(/<known>\nLangChain\nOld Rejected Thing\n<\/known>/);

    const pending = rows(PROPOSAL_PK).filter((p) => p.status === "pending");
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "discovery-2026-11-10-quill",
          kind: "add",
          name: "Quill",
          quadrant: "DevTools",
          ring: "Assess",
          origin: "discovery",
          description: "A Rust-based bundler for TypeScript projects.",
          rationale: "Trending on Hacker News (512 points).",
          sourceTitle: HN_ITEMS[0]!.title,
          sourceLink: "https://quill.dev",
        }),
        expect.objectContaining({
          name: "Zeta-9",
          quadrant: "Models",
          rationale: "In the last day's AI news.",
          sourceLink: "https://a/1",
        }),
      ]),
    );
    expect(pending).toHaveLength(2);
    // Nothing is added to the radar itself.
    expect(rows(BLIP_PK).map((b) => b.id)).toEqual(["langchain"]);
    expect(table.get(keyOf({ pk: SCAN_PK, id: "discovery" }))).toMatchObject({
      at: NOW,
      proposed: 2,
    });
  });

  it("a retried run (same answer) files nothing twice", async () => {
    useDiscoveryModel({ create: vi.fn().mockResolvedValue(answer(technologies)) });
    useDiscoveryFetch(hackerNews());
    await discover();
    const second = await discover();
    expect(second.proposed).toEqual([]);
    expect(rows(PROPOSAL_PK).filter((p) => p.status === "pending")).toHaveLength(2);
  });

  it("goes on with the AI news when Hacker News is down", async () => {
    const create = vi.fn().mockResolvedValue(answer({ technologies: [] }));
    useDiscoveryModel({ create });
    useDiscoveryFetch(
      vi.fn(async () => new Response("", { status: 502 })) as unknown as typeof fetch,
    );
    const run = await discover();
    expect(run).toMatchObject({ newsStories: 2, hackerNewsStories: 0, proposed: [] });
    expect(create).toHaveBeenCalledOnce();
  });

  it("throws (so the schedule retries) when there is nothing to read or the answer is unusable", async () => {
    newsRows.length = 0;
    const create = vi.fn().mockResolvedValue(answer("nope"));
    useDiscoveryModel({ create });
    useDiscoveryFetch(
      vi.fn(async () => new Response("", { status: 502 })) as unknown as typeof fetch,
    );
    await expect(discover()).rejects.toThrow(/no AI news stored and no Hacker News/);
    expect(create).not.toHaveBeenCalled();

    useDiscoveryFetch(hackerNews());
    await expect(discover()).rejects.toThrow(/wasn't the JSON asked for/);
    expect(rows(PROPOSAL_PK).filter((p) => p.status === "pending")).toHaveLength(0);
  });

  it("asks the stored AI news by key, with the reserved word aliased", async () => {
    useDiscoveryModel({ create: vi.fn().mockResolvedValue(answer({ technologies: [] })) });
    useDiscoveryFetch(hackerNews());
    await discover();
    const query = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === NEWS);
    expect(query).toMatchObject({
      KeyConditionExpression: "feed = :feed AND #day >= :since",
      ExpressionAttributeNames: { "#day": "day" },
      ExpressionAttributeValues: { ":feed": "techcrunch-ai", ":since": "2026-11-09" },
    });
  });
});
