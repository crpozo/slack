import type { Attachment, Message } from "./protocol";

// ---------------------------------------------------------------------------
// Pins and a conversation's files & links (Phase 38). The server keeps a small
// index per conversation (the `channel-media` table: one row per file, per
// link and per pinned message), written with the messages themselves, so the
// Files & Links tab and the Pinned panel read one page of rows instead of
// scanning the whole history.
// ---------------------------------------------------------------------------

/** Most messages pinned in one conversation. */
export const MAX_PINS_PER_CHANNEL = 100;
/** Links indexed per message (the rest still show in the message). */
export const MAX_LINKS_PER_MESSAGE = 10;
/** Files or links per page of the Files & Links tab. */
export const MEDIA_PAGE_SIZE = 30;
/** How much of the message a link row keeps, for context. */
export const LINK_SNIPPET_LENGTH = 140;

/**
 * http(s) links as messages show them: they end before trailing punctuation,
 * so "see https://x.ec." links `https://x.ec`. Also used on escaped HTML by
 * the web's markdown renderer.
 */
export const URL_PATTERN = /\bhttps?:\/\/[^\s<]*[^\s<.,;:!?)\]'"]/g;

/** `code` and ```blocks```: their URLs aren't links in the message either. */
const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;

/**
 * The distinct links a message shows (the same ones its text renders as
 * links), in order, at most `MAX_LINKS_PER_MESSAGE`.
 */
export function extractLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.replace(CODE_PATTERN, " ").matchAll(URL_PATTERN)) {
    const url = match[0];
    if (!links.includes(url)) links.push(url);
    if (links.length === MAX_LINKS_PER_MESSAGE) break;
  }
  return links;
}

/** `https://www.youtube.com/watch?v=…` → `youtube.com`. */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Plain text around the links, shortened: what a link row shows under the URL. */
export function linkSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINK_SNIPPET_LENGTH ? `${flat.slice(0, LINK_SNIPPET_LENGTH - 1)}…` : flat;
}

/** Messages whose files and links are indexed: ordinary ones (no secrets, no cards). */
export function isIndexable(message: Pick<Message, "isSecret" | "kind" | "deletedAt">): boolean {
  return !message.isSecret && !message.kind && !message.deletedAt;
}

/** Whether a message can be pinned (any member may; the server checks the channel too). */
export function canPinMessage(message: Pick<Message, "isSecret" | "deletedAt">): boolean {
  return !message.isSecret && !message.deletedAt;
}

/** Where a file or link was shared: enough to jump to its message. */
export interface MediaSource {
  channelId: string;
  messageId: string;
  /** The message's sort key (a reply's is under its parent's thread). */
  messageSk: string;
  /** A thread reply: its parent's sort key (the thread to open). */
  parentSk?: string;
  userId: string;
  /** Epoch ms the message was sent. */
  createdAt: number;
}

export interface ChannelFile extends MediaSource {
  /** Signed for display like in history (images, audio, video carry `url`). */
  attachment: Attachment;
}

export interface ChannelLink extends MediaSource {
  url: string;
  domain: string;
  /** The message's text, shortened. */
  snippet: string;
}

/** `GET /channels/{channelId}/files`. */
export interface ChannelFilesPage {
  files: ChannelFile[];
  nextCursor: string | null;
}

/** `GET /channels/{channelId}/links`. */
export interface ChannelLinksPage {
  links: ChannelLink[];
  nextCursor: string | null;
}

/** `GET /channels/{channelId}/pins`: pinned messages, most recently pinned first. */
export interface ChannelPins {
  messages: Message[];
}

// --- The index rows (the server's `channel-media` table) ------------------------------
//
//   file#<createdAt>#<messageId>#<n>   a file of a message (its attachment)
//   link#<createdAt>#<messageId>#<n>   a link in a message's text
//   pin#<pinnedAt>#<messageId>         a pinned message (a pointer to it)
//
// Times are zero-padded epoch ms, so rows sort by time whatever the message's
// own sort key (a thread reply's starts with `thread#`). Every key can be
// rebuilt from the message itself, so edits and deletions never query the
// index to find what to remove, and the backfill writes the very same rows.

export type MediaKind = "file" | "link";

interface RowBase {
  channelId: string;
  sk: string;
  messageId: string;
  messageSk: string;
  parentSk?: string;
  userId: string;
  createdAt: number;
}
export interface FileRow extends RowBase {
  kind: "file";
  attachment: Attachment;
}
export interface LinkRow extends RowBase {
  kind: "link";
  url: string;
  domain: string;
  snippet: string;
}
export type MediaRow = FileRow | LinkRow;

export interface PinRow {
  channelId: string;
  sk: string;
  kind: "pin";
  messageId: string;
  messageSk: string;
  pinnedAt: number;
  pinnedBy: string;
}

const time = (ms: number) => String(ms).padStart(13, "0");
const index = (n: number) => String(n).padStart(2, "0");

export type IndexedMessage = Pick<
  Message,
  | "channelId"
  | "sk"
  | "messageId"
  | "parentSk"
  | "userId"
  | "createdAt"
  | "text"
  | "attachments"
  | "isSecret"
  | "kind"
  | "deletedAt"
>;

function base(message: IndexedMessage, kind: string, n: number): RowBase {
  return {
    channelId: message.channelId,
    sk: `${kind}#${time(message.createdAt)}#${message.messageId}#${index(n)}`,
    messageId: message.messageId,
    messageSk: message.sk,
    ...(message.parentSk && { parentSk: message.parentSk }),
    userId: message.userId,
    createdAt: message.createdAt,
  };
}

/** A message's file rows: its attachments, stored without download URLs. */
export function fileRows(message: IndexedMessage): FileRow[] {
  if (!isIndexable(message)) return [];
  return (message.attachments ?? []).map((attachment, n) => {
    // Signed URLs expire: never stored (the list signs its page when it's read).
    const stored = { ...attachment };
    delete stored.url;
    delete stored.thumbUrl;
    return { ...base(message, "file", n), kind: "file", attachment: stored };
  });
}

/** A message's link rows: the links its text shows (`extractLinks`). */
export function linkRows(message: IndexedMessage): LinkRow[] {
  if (!isIndexable(message)) return [];
  const snippet = linkSnippet(message.text ?? "");
  return extractLinks(message.text ?? "").map((url, n) => ({
    ...base(message, "link", n),
    kind: "link",
    url,
    domain: linkDomain(url),
    snippet,
  }));
}

export function mediaRows(message: IndexedMessage): MediaRow[] {
  return [...fileRows(message), ...linkRows(message)];
}

/** The pin row of a message pinned at `pinnedAt`. */
export function pinRow(
  message: Pick<Message, "channelId" | "sk" | "messageId">,
  pinnedAt: number,
  pinnedBy: string,
): PinRow {
  return {
    channelId: message.channelId,
    sk: `pin#${time(pinnedAt)}#${message.messageId}`,
    kind: "pin",
    messageId: message.messageId,
    messageSk: message.sk,
    pinnedAt,
    pinnedBy,
  };
}
