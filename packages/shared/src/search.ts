import type { Message } from "./protocol";

// ---------------------------------------------------------------------------
// Message search (Phase 42): an inverted index in DynamoDB. Every message
// (text, file names, a meeting card's title, an AI notes summary) is split
// into terms; each term becomes one small row in `message-search`, keyed by
// the conversation (`channelId`) and `<term>#<message sk>`, written by a
// stream processor whatever wrote the message (sent, edited, deleted).
//
// A search asks each conversation the caller can see for its rows that start
// with the query's longest term (`begins_with`, so "logi" finds "login"),
// then reads those messages and keeps the ones that contain every term.
// Secrets and deleted messages are never indexed.
// ---------------------------------------------------------------------------

/** Shorter terms aren't indexed (nor searched). */
export const SEARCH_MIN_TERM = 2;
/** Longer "words" (hashes, base64) are cut to this. */
export const SEARCH_MAX_TERM = 40;
/** The most terms one message adds to the index. */
export const SEARCH_MAX_TERMS_PER_MESSAGE = 200;
/** The longest query accepted. */
export const SEARCH_MAX_QUERY = 100;
/** How many results a search returns, newest first. */
export const SEARCH_MAX_RESULTS = 30;
/** Characters of context around the first match in a snippet. */
export const SEARCH_SNIPPET_CHARS = 160;

/**
 * Words too common to be worth a row each (English and Spanish): most
 * messages have several, so leaving them out cuts the index's writes by about
 * a third. A query made only of them finds nothing.
 */
const STOP_WORDS = new Set(
  (
    "to of in on is it at as be by or an if we us my me do so no up " +
    "de el la en un lo se al es su mi tu ya le si ni " +
    "the and for are but not you all any can her was one our out has had his how its may new now " +
    "see two who did get him let say she too use that with this from they will have your what when " +
    "there their which would about been into than them then were some just also more like over " +
    "las los del que por con una para como pero sus les mas ese esa esto esta este eso hay muy " +
    "sin sobre entre cuando todo nos fue era han son ser porque donde quien desde hasta"
  ).split(" "),
);

/** Lowercase, accents gone ("Qué" → "que"), so either spelling finds the other. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** The searchable terms of `text`, in order, each once. */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of normalizeForSearch(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].slice(0, SEARCH_MAX_TERM);
    if (term.length < SEARCH_MIN_TERM || STOP_WORDS.has(term)) continue;
    terms.add(term);
    if (terms.size === SEARCH_MAX_TERMS_PER_MESSAGE) break;
  }
  return [...terms];
}

/**
 * What of a message is searchable: its text, its files' names, a meeting
 * card's title and an AI notes summary. Nothing for a secret or a deleted
 * message.
 */
export function searchableText(
  message: Pick<Message, "text" | "attachments" | "isSecret" | "deletedAt" | "meeting" | "aiNotes">,
): string {
  if (message.isSecret || message.deletedAt) return "";
  return [
    message.text,
    ...(message.attachments ?? []).map((a) => a.name),
    message.meeting?.title,
    message.aiNotes?.summary,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

/** A message's index terms (none for a secret or a deleted message). */
export const messageSearchTerms = (message: Parameters<typeof searchableText>[0]) =>
  searchTerms(searchableText(message));

/**
 * Whether `text` matches the query terms: each one starts some word of it
 * ("logi" matches "login"), so results agree with the index's prefix lookup.
 */
export function matchesAllTerms(text: string, queryTerms: string[]): boolean {
  const words = new Set(searchTerms(text));
  return queryTerms.every((q) => [...words].some((w) => w.startsWith(q)));
}

/** A result's excerpt and where in it the query's words start and end. */
export interface SearchSnippet {
  text: string;
  /** `[start, end)` character ranges in `text` to highlight. */
  highlights: Array<[number, number]>;
}

/**
 * About `SEARCH_SNIPPET_CHARS` of `text` around its first match, cut at
 * words, with "…" where it was cut, and the words starting with a query term
 * marked. Accent- and case-insensitive, so "que" marks "Qué".
 */
export function searchSnippet(text: string, queryTerms: string[]): SearchSnippet {
  const flat = text.replace(/\s+/g, " ").trim();
  // Each word of `flat`, with its normalized form, to find and mark matches.
  const words = [...flat.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    norm: normalizeForSearch(m[0]),
  }));
  const hits = words.filter((w) => queryTerms.some((q) => w.norm.startsWith(q)));
  const first = hits[0]?.start ?? 0;
  let start = Math.max(0, first - Math.floor(SEARCH_SNIPPET_CHARS / 3));
  let end = Math.min(flat.length, start + SEARCH_SNIPPET_CHARS);
  start = Math.max(0, Math.min(start, end - SEARCH_SNIPPET_CHARS));
  // Cut at word boundaries.
  if (start > 0) start = flat.indexOf(" ", start) + 1 || start;
  if (end < flat.length)
    end = flat.lastIndexOf(" ", end) > start ? flat.lastIndexOf(" ", end) : end;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const shift = prefix.length - start;
  return {
    text: `${prefix}${flat.slice(start, end)}${suffix}`,
    highlights: hits
      .filter((w) => w.start >= start && w.end <= end)
      .map((w): [number, number] => [w.start + shift, w.end + shift]),
  };
}

/** The time (epoch ms) in a message sort key: `<ms>#<id>`, or a reply's `thread#<parent sk>#<ms>#<id>`. */
export function sortKeyTime(sk: string): number {
  const parts = sk.split("#");
  const ms = Number(parts[0] === "thread" ? parts[3] : parts[0]);
  return Number.isFinite(ms) ? ms : 0;
}

/** One row of the index: `channelId` + `sk` = `<term>#<message sk>`. */
export const searchIndexSk = (term: string, messageSk: string) => `${term}#${messageSk}`;

/** The message sort key of an index row's `sk`. */
export const messageSkOfIndexSk = (indexSk: string) => indexSk.slice(indexSk.indexOf("#") + 1);

export interface SearchResult {
  channelId: string;
  messageId: string;
  /** The message's sort key (where to jump). */
  sk: string;
  /** A thread reply: its parent's sort key (open the thread there). */
  parentSk?: string;
  userId: string;
  /** Epoch ms. */
  createdAt: number;
  snippet: SearchSnippet;
}

/** `GET /search?q=…[&channelId=…]`. */
export interface SearchResponse {
  results: SearchResult[];
  /** The terms searched for (the query without short and common words). */
  terms: string[];
  /** There may be older matches than these (a conversation had more rows than were read). */
  truncated: boolean;
}
