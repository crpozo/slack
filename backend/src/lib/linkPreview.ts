import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LINK_PREVIEW_MAX_URL, type LinkPreview } from "@mindfultech/shared";
import { coverImageOf, decodeEntities } from "./news";

// ---------------------------------------------------------------------------
// Reads a page's preview (Phase 63): Open Graph / Twitter-card tags, else its
// <title> and description. The address comes from a message, so it is treated
// as hostile: https only, public hosts only (the name is resolved and every
// address checked, at each redirect), a short timeout and only the page's
// head. Remembered in the warm container for a day.
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 4_000;
const MAX_BYTES = 400 * 1024;
const MAX_REDIRECTS = 4;
const KEEP_MS = 24 * 60 * 60 * 1000;
const KEEP_MISS_MS = 10 * 60 * 1000;
const MAX_REMEMBERED = 500;
const USER_AGENT = "MindfulTechSlack-LinkPreview/1.0 (+https://slack.mindfultech.ec)";

type Lookup = (host: string) => Promise<string[]>;
const resolveAll: Lookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return false;
    // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast).
    return !/^(f[cd]|fe[89ab]|ff)/.test(lower);
  }
  return false;
}

/** The URL if it may be fetched: https, a real public host name, no credentials or odd port. */
export async function publicHttpsUrl(
  value: string,
  lookup: Lookup = resolveAll,
): Promise<URL | null> {
  if (value.length > LINK_PREVIEW_MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return null; // a page people share has a name
  if (!host.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/i.test(host)) return null;
  try {
    const addresses = await lookup(host);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) return null;
  } catch {
    return null;
  }
  return url;
}

const META_TAG = /<meta\b[^>]*>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
const clean = (text: string, max: number) => {
  const flat = decodeEntities(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The preview a page's head describes, or `null` when it has no title. */
export function previewOf(html: string, pageUrl: string, asked = pageUrl): LinkPreview | null {
  const meta: Record<string, string> = {};
  for (const [tag] of html.matchAll(META_TAG)) {
    const key = (
      ATTR("property").exec(tag)?.[2] ??
      ATTR("name").exec(tag)?.[2] ??
      ""
    ).toLowerCase();
    const content = ATTR("content").exec(tag)?.[2];
    if (key && content && !(key in meta)) meta[key] = content;
  }
  const pageTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const title = clean(meta["og:title"] ?? meta["twitter:title"] ?? pageTitle, 200);
  if (!title) return null;
  const description = clean(
    meta["og:description"] ?? meta["twitter:description"] ?? meta["description"] ?? "",
    400,
  );
  const image = coverImageOf(html, pageUrl);
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  return {
    url: asked,
    title,
    ...(description && { description }),
    ...(image && { image }),
    site: clean(meta["og:site_name"] ?? "", 60) || host,
  };
}

/** The first bytes of a page (its head), following redirects only to public https hosts. */
async function readHead(start: URL, fetchImpl: typeof fetch, lookup: Lookup) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      const target = next ? await publicHttpsUrl(new URL(next, url).href, lookup) : null;
      if (!target) return null;
      url = target;
      continue;
    }
    if (!response.ok || !/html/i.test(response.headers.get("content-type") ?? "")) return null;
    const reader = response.body?.getReader();
    if (!reader) return { html: (await response.text()).slice(0, MAX_BYTES), url };
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    void reader.cancel().catch(() => undefined);
    return { html, url };
  }
  return null;
}

/** X shows a page of scripts to readers like this one; its public oEmbed says who and what. */
async function xPreview(url: URL, fetchImpl: typeof fetch): Promise<LinkPreview | null> {
  const response = await fetchImpl(
    `https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(url.href)}`,
    {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { author_name?: unknown; html?: unknown };
  const author = typeof data.author_name === "string" ? data.author_name : "";
  const body =
    typeof data.html === "string" ? (/<p[^>]*>([\s\S]*?)<\/p>/i.exec(data.html)?.[1] ?? "") : "";
  const text = clean(body.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""), 400);
  if (!author && !text) return null;
  return {
    url: url.href,
    title: author ? `${clean(author, 120)} on X` : "X",
    ...(text && { description: text }),
    site: "x.com",
  };
}

const remembered = new Map<string, { preview: LinkPreview | null; until: number }>();
/** Tests only. */
export function resetLinkPreviews(): void {
  remembered.clear();
}

/** The preview of `link`, or `null`: never throws (a page that can't be read has none). */
export async function linkPreview(
  link: string,
  fetchImpl: typeof fetch = fetch,
  lookup: Lookup = resolveAll,
  now = Date.now(),
): Promise<LinkPreview | null> {
  const known = remembered.get(link);
  if (known && known.until > now) return known.preview;
  let preview: LinkPreview | null = null;
  try {
    const url = await publicHttpsUrl(link, lookup);
    if (url) {
      const host = url.hostname.replace(/^(www|mobile)\./, "");
      if (host === "x.com" || host === "twitter.com") {
        preview = await xPreview(url, fetchImpl);
      } else {
        const page = await readHead(url, fetchImpl, lookup);
        preview = page ? previewOf(page.html, page.url.href, link) : null;
      }
    }
  } catch {
    preview = null;
  }
  if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
  remembered.set(link, { preview, until: now + (preview ? KEEP_MS : KEEP_MISS_MS) });
  return preview;
}
