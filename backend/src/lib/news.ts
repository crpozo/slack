import {
  NEWS_CACHE_SECONDS,
  NEWS_FEED_URL,
  NEWS_MAX_ARTICLES,
  NEWS_SNIPPET_CHARS,
  NEWS_SOURCE,
  type NewsArticle,
  type NewsResponse,
} from "@mindfultech/shared";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// AI News (Phase 35b): reads the TechCrunch AI RSS feed and turns it into a
// clean list of articles. Stateless: the parsed list lives in this module
// (one copy per warm Lambda container) for `NEWS_CACHE_SECONDS`, and the last
// good list is served when the feed can't be read. Nothing is written
// anywhere.
// ---------------------------------------------------------------------------

/** How long the feed may take to answer. */
export const FEED_TIMEOUT_MS = 5_000;
/** The most feed we read (TechCrunch's is ~100 KB). */
export const MAX_FEED_BYTES = 3 * 1024 * 1024;
/** After a failed read, the last good list is served this long before trying again. */
export const RETRY_AFTER_FAILURE_MS = 60_000;

type XmlNode = Record<string, unknown>;

/** Elements that may repeat: always arrays, so one item reads like many. */
const ARRAYS = new Set(["item", "media:content", "media:thumbnail", "enclosure", "category"]);

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

/** RFC 822 (`Mon, 26 Oct 2026 14:05:00 +0000`) to ISO, or `null`. */
export function isoDate(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The feed's articles, newest first, at most `NEWS_MAX_ARTICLES`. Throws on XML that isn't RSS. */
export function parseFeed(xml: string): NewsArticle[] {
  const doc = parser.parse(xml) as XmlNode;
  const channel = (doc["rss"] as XmlNode | undefined)?.["channel"] as XmlNode | undefined;
  if (!channel) throw new Error("not an RSS feed");
  const articles: NewsArticle[] = [];
  for (const item of asList(channel["item"])) {
    const title = plainText(textOf(item["title"]));
    const link = httpsUrl(textOf(item["link"]) || textOf(item["guid"]));
    if (!title || !link) continue;
    const summary =
      plainText(textOf(item["description"])) || plainText(textOf(item["content:encoded"]));
    articles.push({
      title,
      link,
      snippet: clip(summary),
      pubDate: isoDate(textOf(item["pubDate"])),
      imageUrl: imageOf(item),
    });
  }
  return articles
    .sort((a, b) => (b.pubDate ?? "").localeCompare(a.pubDate ?? ""))
    .slice(0, NEWS_MAX_ARTICLES);
}

/** Downloads the feed, refusing what's slow, huge or not XML. */
export async function fetchFeed(
  fetchImpl: typeof fetch = fetch,
  url = NEWS_FEED_URL,
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
  if (type && !/xml|rss/i.test(type)) throw new Error(`feed isn't XML (${type})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_FEED_BYTES) throw new Error("feed too large");
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new Error("feed too large");
  return text;
}

// --- The warm container's copy ------------------------------------------------------

let cached: { response: NewsResponse; until: number } | null = null;

/** Forget the cached list (tests). */
export function resetNewsCache(): void {
  cached = null;
}

/**
 * The articles: this container's copy while it's fresh, else the feed read
 * now. When the feed can't be read, the last good list is served marked
 * `stale` (and tried again on the next request); with none yet, it throws.
 */
export async function getNews(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ response: NewsResponse; fromCache: boolean; expiresAt: number }> {
  if (cached && now < cached.until) {
    return { response: cached.response, fromCache: true, expiresAt: cached.until };
  }
  try {
    const articles = parseFeed(await fetchFeed(fetchImpl));
    const response: NewsResponse = { articles, source: NEWS_SOURCE, fetchedAt: now };
    cached = { response, until: now + NEWS_CACHE_SECONDS * 1000 };
    return { response, fromCache: false, expiresAt: cached.until };
  } catch (err) {
    if (!cached) throw err;
    // Don't make every request wait for a feed that's down: try again in a minute.
    cached = { response: cached.response, until: now + RETRY_AFTER_FAILURE_MS };
    return {
      response: { ...cached.response, stale: true },
      fromCache: true,
      expiresAt: cached.until,
    };
  }
}
