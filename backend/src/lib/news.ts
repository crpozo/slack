import {
  NEWS_CACHE_SECONDS,
  NEWS_FEEDS,
  NEWS_FUTURE_TOLERANCE_MS,
  NEWS_MAX_AGE_MS,
  NEWS_MAX_ARTICLES,
  NEWS_MAX_PER_SOURCE,
  NEWS_REFRESH_MIN_SECONDS,
  NEWS_SNIPPET_CHARS,
  type NewsArticle,
  type NewsFeed,
  type NewsResponse,
} from "@mindfultech/shared";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// AI News (Phase 35b; several sources since Phase 41): reads each source's
// RSS or Atom feed at once and merges them into one clean list of articles.
// A source that's down, slow or answers garbage is left out; the rest still
// make the list. Stateless: the list lives in this module (one copy per warm
// Lambda container) for `NEWS_CACHE_SECONDS`, and the last good list is
// served when no feed can be read. Nothing is written anywhere.
// ---------------------------------------------------------------------------

/**
 * How long one feed may take to answer. A source with a second address can
 * take two tries: 8 s, inside the Lambda's 15.
 */
export const FEED_TIMEOUT_MS = 4_000;
/** The most feed we read (most are 50–300 KB). */
export const MAX_FEED_BYTES = 3 * 1024 * 1024;
/** After a failed read, the last good list is served this long before trying again. */
export const RETRY_AFTER_FAILURE_MS = 60_000;
/** A list missing a source (it was down) is kept this long, then every feed is read again. */
export const RETRY_PARTIAL_MS = 5 * 60_000;

type XmlNode = Record<string, unknown>;

/** Elements that may repeat: always arrays, so one item reads like many. */
const ARRAYS = new Set([
  "item",
  "entry",
  "media:content",
  "media:thumbnail",
  "enclosure",
  "category",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep text as text (no number/boolean guessing): titles like "2025" stay strings.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // `&#8217;`, `&hellip;`, `&amp;`… become the characters they stand for.
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => ARRAYS.has(name),
});

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;

/** `value` as a usable https URL, or `null`. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The text of an element: a plain value, CDATA, or `#text` next to attributes. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const node = value as XmlNode;
    if (typeof node["#text"] === "string") return node["#text"];
    if (typeof node["__cdata"] === "string") return node["__cdata"];
  }
  return "";
}

const asList = (value: unknown): XmlNode[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
    (v): v is XmlNode => !!v && typeof v === "object",
  );

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Entities left in HTML-escaped text (CDATA isn't decoded by the parser). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML to plain text: tags out, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** At most `max` characters, cut at a word, with an ellipsis when cut. */
export function clip(text: string, max = NEWS_SNIPPET_CHARS): string {
  // WordPress's own "The post … appeared first on …" footer isn't part of the story.
  const body = text.replace(/\s*The post .* appeared first on .*$/i, "").trim();
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const atWord = cut
    .slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))
    .replace(/[\s,.;:–—-]+$/, "");
  return `${atWord}…`;
}

/** The first `<img src>` in some HTML (absolute https only). */
export function firstImageIn(html: string): string | null {
  for (const match of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(["'])(.*?)\1/gi)) {
    const url = httpsUrl(decodeEntities(match[2] ?? ""));
    if (url) return url;
  }
  return null;
}

const isImageType = (type: unknown) => typeof type === "string" && type.startsWith("image/");

/**
 * The item's image, from the first source that has one:
 * 1. `<media:content>` that is an image (by `medium`, `type` or extension),
 *    the widest when there are several;
 * 2. `<media:thumbnail>`;
 * 3. an image `<enclosure>`;
 * 4. the first `<img src>` in `content:encoded`, then in `description`.
 */
export function imageOf(item: XmlNode): string | null {
  const media = asList(item["media:content"])
    .filter((m) => {
      const url = String(m["@_url"] ?? "");
      return m["@_medium"] === "image" || isImageType(m["@_type"]) || IMAGE_EXT.test(url);
    })
    .map((m) => ({ url: httpsUrl(m["@_url"]), width: Number(m["@_width"]) || 0 }))
    .filter((m): m is { url: string; width: number } => m.url !== null)
    .sort((a, b) => b.width - a.width);
  if (media[0]) return media[0].url;

  for (const thumb of asList(item["media:thumbnail"])) {
    const url = httpsUrl(thumb["@_url"]);
    if (url) return url;
  }
  for (const enclosure of asList(item["enclosure"])) {
    const url = httpsUrl(enclosure["@_url"]);
    if (url && (isImageType(enclosure["@_type"]) || IMAGE_EXT.test(url))) return url;
  }
  return firstImageIn(textOf(item["content:encoded"])) ?? firstImageIn(textOf(item["description"]));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Zone names RFC 822 allows (and a few feeds use), as offsets in minutes. */
const ZONES: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  BST: 60,
  CET: 60,
  CEST: 120,
};

/** `+0530`, `-04:00` or a zone name as minutes east of UTC; missing or unknown is UTC. */
function zoneOffset(zone: string | undefined): number {
  if (!zone) return 0;
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (numeric) {
    const minutes = Number(numeric[2]) * 60 + Number(numeric[3]);
    return numeric[1] === "-" ? -minutes : minutes;
  }
  return ZONES[zone.toUpperCase()] ?? 0;
}

/** Epoch ms from date parts, or `null` when they aren't a real date and time. */
function utcTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number,
): number | null {
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  const ms =
    Date.UTC(year, month, day, hour, minute, Math.min(second, 59)) - offsetMinutes * 60_000;
  return Number.isFinite(ms) ? ms : null;
}

/** ISO 8601 / RFC 3339 (Atom, `dc:date`): a missing zone is UTC, a date alone is midnight UTC. */
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
/**
 * RFC 822 / 2822 (RSS `pubDate`), leniently: the weekday is optional and
 * ignored (feeds get it wrong), months may be spelled out, two-digit years
 * are this century, seconds are optional, the zone is numeric or a name.
 */
const RFC822_DATE =
  /^(?:[a-z]+\.?,?\s*)?(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{4}|\d{2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2}|[a-z]{1,4})?\b/i;

/**
 * When a story was published (epoch ms), from any of the date formats the
 * feeds use: RSS's RFC 822 (`Mon, 26 Oct 2026 14:05:00 +0000`, `… GMT`,
 * `… EDT`), Atom's ISO 8601 (`2026-10-26T15:30:00-04:00`) and the near-misses
 * seen in the wild (no zone, a space instead of `T`, a spelled-out month).
 * Anything else that `Date.parse` understands is the last resort; `null`
 * when nothing does.
 */
export function feedTime(value: string): number | null {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = iso;
    return utcTime(+y!, +mo! - 1, +d!, +h, +mi, +s, zoneOffset(zone));
  }
  const rfc = RFC822_DATE.exec(text);
  if (rfc) {
    const [, d, mon, y, h, mi, s = "0", zone] = rfc;
    const month = MONTHS.indexOf(mon!.toLowerCase());
    if (month < 0) return null;
    const year = y!.length === 2 ? 2000 + Number(y) : Number(y);
    return utcTime(year, month, +d!, +h!, +mi!, +s, zoneOffset(zone));
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** A feed date as ISO 8601 (UTC), or `null` when it can't be read. */
export function isoDate(value: string): string | null {
  const ms = feedTime(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Whether a story is news at `now`: published within `NEWS_MAX_AGE_MS`
 * (and not implausibly in the future). No date, no way to know: not news.
 */
export function isRecent(pubDate: string | null, now: number): boolean {
  if (!pubDate) return false;
  const ms = Date.parse(pubDate);
  return ms >= now - NEWS_MAX_AGE_MS && ms <= now + NEWS_FUTURE_TOLERANCE_MS;
}

/** An Atom entry's page: the `rel="alternate"` link (or one with no `rel`), else its id. */
function atomLink(entry: XmlNode): string | null {
  const links = asList(entry["link"]);
  const page =
    links.find((l) => l["@_rel"] === "alternate") ?? links.find((l) => l["@_rel"] === undefined);
  return httpsUrl(page?.["@_href"]) ?? httpsUrl(textOf(entry["id"]));
}

/** An Atom entry's image: as for RSS, plus a `<link rel="enclosure">` that's an image. */
function atomImage(entry: XmlNode): string | null {
  const image = imageOf({
    ...entry,
    "content:encoded": entry["content"],
    description: entry["summary"],
  });
  if (image) return image;
  for (const link of asList(entry["link"])) {
    const url = httpsUrl(link["@_href"]);
    if (
      link["@_rel"] === "enclosure" &&
      url &&
      (isImageType(link["@_type"]) || IMAGE_EXT.test(url))
    ) {
      return url;
    }
  }
  return null;
}

/** An item's categories: RSS text (`<category>AI</category>`) or Atom terms (`term="AI"`). */
function categoriesOf(item: XmlNode): string[] {
  const values = Array.isArray(item["category"]) ? (item["category"] as unknown[]) : [];
  return values
    .map((c) => textOf(c) || String((c as XmlNode | null)?.["@_term"] ?? ""))
    .map((c) => plainText(c))
    .filter(Boolean);
}

/** One story, as read from the feed, before the source is known to be about AI. */
interface FeedStory extends NewsArticle {
  categories: string[];
}

/** An RSS `<item>` as an article, or `null` without a title or an https link. */
function rssStory(item: XmlNode, sourceName: string): FeedStory | null {
  const title = plainText(textOf(item["title"]));
  const link = httpsUrl(textOf(item["link"]) || textOf(item["guid"]));
  if (!title || !link) return null;
  const summary =
    plainText(textOf(item["description"])) || plainText(textOf(item["content:encoded"]));
  return {
    title,
    link,
    snippet: clip(summary),
    pubDate: isoDate(textOf(item["pubDate"]) || textOf(item["dc:date"])),
    imageUrl: imageOf(item),
    sourceName,
    categories: categoriesOf(item),
  };
}

/** An Atom `<entry>` as an article, or `null` without a title or an https link. */
function atomStory(entry: XmlNode, sourceName: string): FeedStory | null {
  const title = plainText(textOf(entry["title"]));
  const link = atomLink(entry);
  if (!title || !link) return null;
  const summary = plainText(textOf(entry["summary"])) || plainText(textOf(entry["content"]));
  return {
    title,
    link,
    snippet: clip(summary),
    pubDate: isoDate(textOf(entry["published"]) || textOf(entry["updated"])),
    imageUrl: atomImage(entry),
    sourceName,
    categories: categoriesOf(entry),
  };
}

/** Words that make a story from a general tech feed an AI story. */
const AI_TOPIC =
  /\b(?:A\.?I\.?|AGI|LLMs?|GPT[\w.-]*|ML|artificial intelligence|machine learning|deep learning|neural|generative|chatbots?|ChatGPT|OpenAI|Anthropic|Claude|Gemini|DeepMind|Copilot|Llama|Mistral|xAI|Grok|Perplexity|Nvidia|agentic|AI agents?)\b/;

/** Whether a story from a general feed is about AI: its title, categories or snippet say so. */
export function isAboutAi(story: Pick<FeedStory, "title" | "snippet" | "categories">): boolean {
  return [story.title, ...story.categories, story.snippet].some((text) => AI_TOPIC.test(text));
}

/** A feed's stories, and how many were dropped as too old or undated. */
export interface FeedRead {
  articles: NewsArticle[];
  /** Published more than `NEWS_MAX_AGE_HOURS` before `now`. */
  stale: number;
  /** No publication date that could be read (or one far in the future). */
  undated: number;
}

/**
 * A feed's articles (RSS 2.0, RSS 1.0 or Atom), newest first, at most
 * `NEWS_MAX_ARTICLES`, each marked with `sourceName`. Only news: a story
 * published more than `NEWS_MAX_AGE_HOURS` before `now`, or with no date that
 * can be read, is dropped first, before the cap. A malformed item is skipped,
 * not fatal; `general` keeps only the AI stories. Throws on a document that
 * isn't a feed at all (an error page, a login wall).
 */
export function readFeed(
  xml: string,
  sourceName: string,
  { general = false, now = Date.now() }: { general?: boolean; now?: number } = {},
): FeedRead {
  const doc = parser.parse(xml) as XmlNode;
  const rss = (doc["rss"] as XmlNode | undefined)?.["channel"] as XmlNode | undefined;
  const rdf = doc["rdf:RDF"] as XmlNode | undefined;
  const atom = doc["feed"] as XmlNode | undefined;
  const items: { node: XmlNode; read: typeof rssStory }[] = rss
    ? asList(rss["item"]).map((node) => ({ node, read: rssStory }))
    : rdf
      ? asList(rdf["item"]).map((node) => ({ node, read: rssStory }))
      : atom
        ? asList(atom["entry"]).map((node) => ({ node, read: atomStory }))
        : [];
  if (!rss && !rdf && !atom) throw new Error("not an RSS or Atom feed");
  const result: FeedRead = { articles: [], stale: 0, undated: 0 };
  for (const { node, read } of items) {
    let story: FeedStory | null;
    try {
      story = read(node, sourceName);
    } catch {
      continue; // one odd item doesn't cost the feed
    }
    if (!story || (general && !isAboutAi(story))) continue;
    const { title, link, snippet, pubDate, imageUrl } = story;
    if (!isRecent(pubDate, now)) {
      if (pubDate && Date.parse(pubDate) < now) result.stale++;
      else result.undated++;
      continue;
    }
    result.articles.push({ title, link, snippet, pubDate, imageUrl, sourceName });
  }
  result.articles = newestFirst(result.articles).slice(0, NEWS_MAX_ARTICLES);
  return result;
}

/** `readFeed`'s articles alone. */
export function parseFeed(
  xml: string,
  sourceName: string,
  options: { general?: boolean; now?: number } = {},
): NewsArticle[] {
  return readFeed(xml, sourceName, options).articles;
}

const newestFirst = (articles: NewsArticle[]) =>
  [...articles].sort((a, b) => (b.pubDate ?? "").localeCompare(a.pubDate ?? ""));

/** A link without what varies between feeds for the same page (tracking query, `#`, trailing `/`). */
function canonicalLink(link: string): string {
  const url = new URL(link);
  return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
}

const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Every source's articles as one list: newest first, the same story once
 * (by link or title, the first source's copy kept), at most
 * `NEWS_MAX_PER_SOURCE` from each source and `NEWS_MAX_ARTICLES` in all.
 */
export function mergeArticles(lists: NewsArticle[][]): NewsArticle[] {
  const links = new Set<string>();
  const titles = new Set<string>();
  const perSource = new Map<string, number>();
  const merged: NewsArticle[] = [];
  for (const article of newestFirst(lists.flat())) {
    const link = canonicalLink(article.link);
    const title = titleKey(article.title);
    if (links.has(link) || titles.has(title)) continue;
    const count = perSource.get(article.sourceName) ?? 0;
    if (count >= NEWS_MAX_PER_SOURCE) continue;
    links.add(link);
    titles.add(title);
    perSource.set(article.sourceName, count + 1);
    merged.push(article);
    if (merged.length === NEWS_MAX_ARTICLES) break;
  }
  return merged;
}

/** Downloads the feed, refusing what's slow, huge or not XML. */
export async function fetchFeed(
  fetchImpl: typeof fetch = fetch,
  url = NEWS_FEEDS[0]!.urls[0]!.url,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      "user-agent": "MindfulTechSlack/1.0 (+https://slack.mindfultech.ec)",
    },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`feed answered ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (type && !/xml|rss|atom/i.test(type)) throw new Error(`feed isn't XML (${type})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_FEED_BYTES) throw new Error("feed too large");
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new Error("feed too large");
  return text;
}

/** One source's recent articles: its first address that reads as a feed, else the last error. */
export async function readSource(
  feed: NewsFeed,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<FeedRead> {
  let failure: unknown = new Error(`${feed.name} has no feed address`);
  for (const { url, general } of feed.urls) {
    try {
      return readFeed(await fetchFeed(fetchImpl, url), feed.name, { general, now });
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

export interface NewsRead {
  articles: NewsArticle[];
  /** The sources that answered, in `NEWS_FEEDS` order. */
  sources: string[];
  /** The ones that didn't, and why. */
  failed: { source: string; error: string }[];
  /** Stories each source had that were left out as older than `NEWS_MAX_AGE_HOURS` or undated. */
  discarded: { source: string; stale: number; undated: number }[];
}

/**
 * Every source at once, only their stories of the last `NEWS_MAX_AGE_HOURS`
 * (at `now`), merged. Throws only when none could be read (the first
 * source's error); otherwise the ones that failed are in `failed`.
 */
export async function readAllSources(
  fetchImpl: typeof fetch = fetch,
  feeds: readonly NewsFeed[] = NEWS_FEEDS,
  now = Date.now(),
): Promise<NewsRead> {
  const results = await Promise.allSettled(feeds.map((feed) => readSource(feed, fetchImpl, now)));
  const read: NewsRead = { articles: [], sources: [], failed: [], discarded: [] };
  const lists: NewsArticle[][] = [];
  results.forEach((result, i) => {
    const source = feeds[i]!.name;
    if (result.status === "fulfilled") {
      const { articles, stale, undated } = result.value;
      read.sources.push(source);
      lists.push(articles);
      if (stale + undated > 0) read.discarded.push({ source, stale, undated });
    } else {
      const reason: unknown = result.reason;
      read.failed.push({
        source,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  if (read.sources.length === 0) {
    const first = results[0];
    throw first?.status === "rejected" ? first.reason : new Error("no news sources");
  }
  read.articles = mergeArticles(lists);
  return read;
}

// --- The warm container's copy ------------------------------------------------------

let cached: { response: NewsResponse; until: number; readAt: number } | null = null;

/** The cached list at `now`: a story that has aged past `NEWS_MAX_AGE_HOURS` since is gone. */
const cachedAt = (response: NewsResponse, now: number): NewsResponse => ({
  ...response,
  articles: response.articles.filter((a) => isRecent(a.pubDate, now)),
});

/** Forget the cached list (tests). */
export function resetNewsCache(): void {
  cached = null;
}

/**
 * The articles: this container's copy while it's fresh, else every feed read
 * now. `refresh` ("Refresh news") reads them again even while the copy is
 * fresh, unless they were read within `NEWS_REFRESH_MIN_SECONDS`. A list
 * missing a source that was down is kept only `RETRY_PARTIAL_MS`. When no
 * feed can be read, the last good list is served marked `stale` (and tried
 * again a minute later); with none yet, it throws.
 */
export async function getNews(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  refresh = false,
): Promise<{
  response: NewsResponse;
  fromCache: boolean;
  expiresAt: number;
  failed?: NewsRead["failed"];
  discarded?: NewsRead["discarded"];
}> {
  const fresh = cached && now < cached.until;
  const justRead = cached && now - cached.readAt < NEWS_REFRESH_MIN_SECONDS * 1000;
  if (cached && (refresh ? justRead : fresh)) {
    return { response: cachedAt(cached.response, now), fromCache: true, expiresAt: cached.until };
  }
  try {
    const { articles, sources, failed, discarded } = await readAllSources(
      fetchImpl,
      NEWS_FEEDS,
      now,
    );
    const response: NewsResponse = { articles, source: sources.join(", "), fetchedAt: now };
    const until = now + (failed.length > 0 ? RETRY_PARTIAL_MS : NEWS_CACHE_SECONDS * 1000);
    cached = { response, until, readAt: now };
    return { response, fromCache: false, expiresAt: until, failed, discarded };
  } catch (err) {
    if (!cached) throw err;
    // Don't make every request wait for feeds that are down: try again in a minute.
    cached = { ...cached, until: now + RETRY_AFTER_FAILURE_MS };
    return {
      response: { ...cachedAt(cached.response, now), stale: true },
      fromCache: true,
      expiresAt: cached.until,
    };
  }
}
