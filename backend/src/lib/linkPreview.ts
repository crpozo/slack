import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  isPreviewableUrl,
  linkDomain,
  MAX_PREVIEW_DESCRIPTION,
  MAX_PREVIEW_TITLE,
  MAX_PREVIEW_URL_LENGTH,
  type LinkPreview,
} from "@mindfultech/shared";
import { Parser } from "htmlparser2";
import { ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";

// ---------------------------------------------------------------------------
// Phase 64: fetching a shared page for its preview card, safely. The URL
// comes from a chat message, so this is a server-side request on anyone's
// behalf: it may only ever reach the public internet.
//   - http(s) on ports 80/443, no credentials in the URL;
//   - every connection's address is checked in the DNS lookup itself (so a
//     name can't resolve public for a check and private for the connect):
//     loopback, private, link-local (the instance metadata service),
//     CGNAT, multicast and reserved ranges are refused, IPv4 and IPv6;
//   - redirects are followed by hand (at most 3), each one checked again;
//   - 5 s in all, 512 KB at most, and only up to </head>.
// ---------------------------------------------------------------------------

export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_REDIRECTS = 3;
/** A preview is kept a day; a page with nothing to show (or that failed), an hour. */
export const PREVIEW_TTL_S = 24 * 60 * 60;
export const EMPTY_TTL_S = 60 * 60;
const USER_AGENT = "Mozilla/5.0 (compatible; LinkPreview/1.0)";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Whether `address` is on the public internet (IPv4-mapped IPv6 is judged as IPv4). */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    // ::ffff:7f00:1 and other hex forms of a mapped IPv4 address.
    if (/^::ffff:/i.test(address)) return false;
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} doesn't resolve to a public address`);
    this.name = "BlockedAddressError";
  }
}

/**
 * The DNS lookup every preview connection makes: all of a name's addresses
 * must be public, or the connection fails before it is opened. Answers in
 * both shapes Node asks for (`all: true` with Happy Eyeballs, or one address).
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new BlockedAddressError(hostname), "", 0);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    }
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** http(s), default ports, no credentials, and a hostname that isn't a non-public IP. */
export function allowedTarget(url: URL): boolean {
  if (!isPreviewableUrl(url.toString())) return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) return false;
  return !/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host);
}

interface Page {
  url: string;
  html: string;
}

/** One GET; resolves with the response (body unread) or rejects. */
function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: safeLookup,
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "es,en;q=0.8",
        },
      },
      resolve,
    );
    req.on("error", reject);
  });
}

/** The start of a page's HTML: up to </head> or `MAX_HTML_BYTES`, whichever comes first. */
function readHead(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      res.destroy();
      resolve(decode(Buffer.concat(chunks), res.headers["content-type"]));
    };
    res.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= MAX_HTML_BYTES || /<\/head\s*>/i.test(chunk.toString("latin1"))) done();
    });
    res.on("end", done);
    res.on("error", reject);
  });
}

/** Bytes to text with the response's charset (utf-8 when unknown or unsupported). */
function decode(bytes: Buffer, contentType: string | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes.subarray(0, MAX_HTML_BYTES));
  } catch {
    return new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_HTML_BYTES));
  }
}

/**
 * Fetches `start`'s HTML head, following up to `MAX_REDIRECTS` redirects
 * (each target checked like the first). `null` for anything that isn't an
 * HTML page answering 200.
 */
export async function fetchPage(start: string): Promise<Page | null> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedTarget(url)) return null;
    const res = await get(url, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    const type = String(res.headers["content-type"] ?? "");
    if (status !== 200 || !/text\/html|application\/xhtml\+xml/i.test(type)) {
      res.resume();
      return null;
    }
    return { url: url.toString(), html: await readHead(res) };
  }
  return null;
}

const clean = (text: string | undefined, max: number): string | undefined => {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** An https URL for the image, resolved against the page; `undefined` otherwise. */
function imageUrl(src: string | undefined, page: string): string | undefined {
  if (!src) return undefined;
  try {
    const url = new URL(src.trim(), page);
    url.protocol = url.protocol === "http:" ? "https:" : url.protocol;
    const value = url.toString();
    return url.protocol === "https:" && value.length <= MAX_PREVIEW_URL_LENGTH ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The card from a page's head: Open Graph first, then Twitter cards, `<title>` and the description meta. */
export function parsePreview(page: Page): LinkPreview | null {
  const meta = new Map<string, string>();
  let title = "";
  let inTitle = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title") inTitle = true;
        if (name !== "meta") return;
        const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
        if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
      },
      ontext(text) {
        if (inTitle) title += text;
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(page.html);
  parser.end();
  const heading =
    clean(meta.get("og:title"), MAX_PREVIEW_TITLE) ??
    clean(meta.get("twitter:title"), MAX_PREVIEW_TITLE) ??
    clean(title, MAX_PREVIEW_TITLE);
  if (!heading) return null;
  const description =
    clean(meta.get("og:description"), MAX_PREVIEW_DESCRIPTION) ??
    clean(meta.get("twitter:description"), MAX_PREVIEW_DESCRIPTION) ??
    clean(meta.get("description"), MAX_PREVIEW_DESCRIPTION);
  const image = imageUrl(meta.get("og:image") ?? meta.get("twitter:image"), page.url);
  const siteName = clean(meta.get("og:site_name"), 80);
  return {
    url: page.url,
    title: heading,
    domain: linkDomain(page.url),
    ...(description && { description }),
    ...(image && { image }),
    ...(siteName && { siteName }),
  };
}

/** The cache key: the URL without its #fragment, hashed (keys stay short). */
export function cacheKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return createHash("sha256").update(parsed.toString()).digest("hex");
}

/**
 * The preview for `url`: from the cache when it's fresh, else fetched and
 * kept (a day; a page with nothing to show or that failed, an hour).
 */
export async function linkPreview(url: string, now = Date.now()): Promise<LinkPreview | null> {
  const key = cacheKey(url);
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.linkPreviews, Key: { urlKey: key } }),
  );
  if (Item && typeof Item.expiresAt === "number" && Item.expiresAt * 1000 > now) {
    return (Item.preview as LinkPreview | undefined) ?? null;
  }
  let preview: LinkPreview | null = null;
  try {
    const page = await fetchPage(url);
    preview = page ? parsePreview(page) : null;
  } catch (err) {
    log.info("link preview fetch failed", { domain: linkDomain(url), ...errorFields(err) });
  }
  const ttl = preview ? PREVIEW_TTL_S : EMPTY_TTL_S;
  await ddb.send(
    new PutCommand({
      TableName: tables.linkPreviews,
      Item: {
        urlKey: key,
        ...(preview && { preview }),
        fetchedAt: now,
        expiresAt: Math.floor(now / 1000) + ttl,
      },
    }),
  );
  return preview;
}
