import { z } from "zod";
import { compareIds, GENERAL_CHANNEL_ID } from "./ids";
import type { Role } from "./roles";
import type { Board, Task, TaskStatus } from "./tasks";
import type { CalendarPushEvent } from "./calendar";

// ---------------------------------------------------------------------------
// Limits & constants
// ---------------------------------------------------------------------------

export const MAX_TEXT_LENGTH = 4000;
export const MAX_ATTACHMENT_SIZE = 500 * 1024 * 1024; // 500 MB (videos, datasets)
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Channel slug: what names must be unique on (see `slugifyChannelName`). */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
/** Human-readable channel name ("Web Design"), shown in the sidebar and header. */
export const MAX_CHANNEL_NAME_LENGTH = 40;
/** The one-liner under the channel's name in its header. */
export const MAX_CHANNEL_TOPIC_LENGTH = 120;
/** What the channel is for; may span lines. */
export const MAX_CHANNEL_DESCRIPTION_LENGTH = 500;
export const HISTORY_PAGE_SIZE = 50;
/**
 * Download URLs are signed against a quantized clock: every URL minted in the
 * same `PRESIGN_GET_WINDOW_SECONDS` window (by the same Lambda credentials) is
 * byte-identical, so the browser's cache keeps serving an image it already
 * has instead of re-fetching it under a fresh signature. Each URL stays valid
 * for `PRESIGN_GET_EXPIRES_SECONDS` from the start of its window: at least an
 * hour after the window ends.
 */
export const PRESIGN_GET_WINDOW_SECONDS = 2 * 60 * 60;
export const PRESIGN_GET_EXPIRES_SECONDS = 3 * 60 * 60;
/** @deprecated Kept for older clients' expectations; download URLs now last `PRESIGN_GET_EXPIRES_SECONDS`. */
export const PRESIGN_EXPIRES_SECONDS = PRESIGN_GET_EXPIRES_SECONDS;
/**
 * Stored on every upload (the presigned PUT signs it): keys are unique ULIDs,
 * so an object never changes and the browser may keep it for a year.
 */
export const ATTACHMENT_CACHE_CONTROL = "private, max-age=31536000, immutable";
/** Image previews: the longest side of the thumbnail the client uploads next to the original. */
export const THUMBNAIL_MAX_SIDE = 1280;
/** Largest dimension an attachment may declare (sanity bound, not a limit on the file). */
export const MAX_IMAGE_DIMENSION = 20_000;
/** Upload URLs: long enough for 500 MB on a slow connection. */
export const PRESIGN_PUT_EXPIRES_SECONDS = 30 * 60;
export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_EMOJI_LENGTH = 16;
export const MAX_INVITES_PER_REQUEST = 50;
/** SDP offers/answers are a few KB; API Gateway frames cap at 32 KB. */
export const MAX_SDP_LENGTH = 20_000;
export const MAX_ICE_CANDIDATE_LENGTH = 2048;

/** Route keys of the WebSocket API (`$request.body.action`). */
export const CLIENT_ACTIONS = [
  "message",
  "history",
  "channel",
  "presign",
  "typing",
  "user",
  "react",
  "call",
  "ping",
  "read",
  "edit",
] as const;
export type ClientActionName = (typeof CLIENT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

const channelId = z.string().min(1).max(256);
const requestId = z.string().min(1).max(64);

export const AttachmentSchema = z.object({
  key: z.string().min(1).max(1024),
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
  contentType: z.string().min(1).max(255),
  /** Voice messages: length in milliseconds, shown before the audio loads. */
  durationMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000)
    .optional(),
  /** Images: a downscaled copy (≤ `THUMBNAIL_MAX_SIDE`) uploaded next to the original. */
  thumbKey: z.string().min(1).max(1024).optional(),
  /** Images: pixel size of what the list shows (the thumbnail when there is one), for layout. */
  width: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
  height: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
});
/**
 * An attachment as stored and sent by clients, plus the signed download URLs
 * the server attaches to image and audio attachments on the way out
 * (`history.page`, `message.new`); never stored, never accepted from a client.
 */
export type Attachment = z.infer<typeof AttachmentSchema> & { url?: string; thumbUrl?: string };

/** Whether the server attaches download URLs to this attachment (shown inline in the list). */
export const isInlineAttachment = (a: Pick<Attachment, "contentType">) =>
  a.contentType.startsWith("image/") || a.contentType.startsWith("audio/");

/** Longest quoted text kept with a reply. */
export const REPLY_PREVIEW_LENGTH = 140;

/** Secret messages (passwords, API keys) are deleted by DynamoDB a week after they're sent. */
export const SECRET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** What a secret looks like anywhere but its own body: previews, quotes, notifications. */
export const SECRET_PREVIEW = "🔒 Secret";

/** Gone (or about to be): DynamoDB deletes expired rows within a few days, so don't wait for it. */
export function isExpired(message: Pick<Message, "expiresAt">, now = Date.now()): boolean {
  return message.expiresAt !== undefined && message.expiresAt * 1000 <= now;
}

/** The quoted text of a reply: whitespace collapsed, cut at `REPLY_PREVIEW_LENGTH` with "…". */
export function replyPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REPLY_PREVIEW_LENGTH ? `${flat.slice(0, REPLY_PREVIEW_LENGTH - 1)}…` : flat;
}

/**
 * What a reply carries about the message it answers, copied by the server
 * when the reply is sent: renders without loading the original.
 */
export interface ReplySnapshot {
  messageId: string;
  sk: string;
  userId: string;
  /** Up to `REPLY_PREVIEW_LENGTH` chars of the original text, whitespace collapsed. */
  preview: string;
  hasAttachments: boolean;
}

/** `private` channels and `dm`s are visible only to their `members`. */
export type ChannelType = "public" | "private" | "dm";
export type ChannelVisibility = Extract<ChannelType, "public" | "private">;

export interface Channel {
  channelId: string;
  /** Human-readable name as typed ("Web Design"); for DMs, the channel id. */
  name: string;
  /**
   * Unique, URL-safe form of `name` ("web-design"). Absent on channels created
   * before names became human-readable, whose `name` already is a slug.
   */
  slug?: string;
  type: ChannelType;
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  archived: boolean;
  /** `private` and `dm` channels: user ids allowed to see the channel. */
  members?: string[];
  /** Short line shown in the channel header ("" or absent: none). */
  topic?: string;
  /** What the channel is for ("" or absent: none). */
  description?: string;
  /** A project channel: its work is tracked on `linkedBoardId` (Task Manager). */
  isProject?: boolean;
  /** The Kanban board of a project channel (`/app/tasks/<boardId>`). */
  linkedBoardId?: string;
  /**
   * Read watermarks: per user, the newest message `sk` they have seen (and
   * when). One row per channel, however many messages: a message is read by
   * someone iff their watermark is >= its `sk` (sort keys order by time).
   */
  reads?: Record<string, ReadMark>;
}

export interface ReadMark {
  sk: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Everyone (but the author) whose watermark covers `message`, sorted. */
export function readBy(message: Pick<Message, "sk" | "userId">, reads: Channel["reads"]): string[] {
  if (!reads) return [];
  return Object.entries(reads)
    .filter(([userId, mark]) => userId !== message.userId && mark.sk >= message.sk)
    .map(([userId]) => userId)
    .sort(compareIds);
}

export const MESSAGE_KINDS = ["meeting"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What a "meeting scheduled" message carries (see `Message.meeting`). */
export interface MeetingCard {
  /** The calendar event this card points at. */
  eventId: string;
  title: string;
  description: string;
  /** DM meetings are timed. */
  allDay: false;
  /** Epoch ms. */
  startAt: number;
  endAt: number;
  /** Both people of the DM, sorted. */
  participants: string[];
}

export interface Message {
  messageId: string;
  channelId: string;
  /** Sort key: `${epochMs}#${ulid}`. */
  sk: string;
  userId: string;
  userEmail: string;
  text: string;
  attachments: Attachment[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** emoji → user ids who reacted with it (absent or empty when none). */
  reactions?: Record<string, string[]>;
  /** Set when this message answers another one in the same channel. */
  replyTo?: ReplySnapshot;
  /** The author changed the text after sending (`editedAt`: epoch ms of the last edit). */
  isEdited?: boolean;
  editedAt?: number;
  /**
   * Who has read it, for the UI. Derived by clients from the channel's read
   * watermarks (`readBy()`): never stored per message.
   */
  readBy?: string[];
  /**
   * The sender's id for this send (stored, so a retry of the same message is
   * recognized, and a reloaded history settles a "failed" optimistic copy).
   */
  clientId?: string;
  /**
   * A password or API key: shown masked until the reader reveals it, never
   * quoted or previewed, can't be edited, and deleted after `SECRET_TTL_MS`.
   */
  isSecret?: true;
  /** Absent for ordinary messages; `"meeting"` renders `meeting` as a card. */
  kind?: MessageKind;
  /**
   * A meeting scheduled from this conversation (Phase 21): a snapshot of the
   * calendar event when it was created, written by the server (the `message`
   * action never accepts it). The event itself is the source of truth; the
   * card's button opens it. Cards can't be edited.
   */
  meeting?: MeetingCard;
  /** DynamoDB TTL (epoch **seconds**): set by the server on secret messages only. */
  expiresAt?: number;
}

export interface UserProfile {
  userId: string;
  email: string;
  /** Primary identifier in the UI; defaults to the local part of the email. */
  displayName: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** Absent for rows written before roles existed: a member. */
  role?: Role;
}

/** Whether `userId` may see `channel`: public channels are open, others need membership. */
export function isChannelMember(
  channel: Pick<Channel, "type" | "members">,
  userId: string,
): boolean {
  return channel.type === "public" || (channel.members ?? []).includes(userId);
}

/**
 * Lowercase, hyphenated, accent-free form of a channel name (`^[a-z0-9-]{1,32}$`
 * when non-empty): "Diseño Web!" → "diseno-web". Uniqueness is checked on this.
 */
export function slugifyChannelName(input: string): string {
  const collapsed = input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^#/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-");
  return trimHyphens(trimHyphens(collapsed).slice(0, 32));
}

/** Strips leading/trailing hyphens without a regex (`-+$` backtracks super-linearly). */
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start++;
  while (end > start && value[end - 1] === "-") end--;
  return value.slice(start, end);
}

/** A channel's slug, also for rows from before `slug` existed. */
export const channelSlug = (channel: Pick<Channel, "name" | "slug">): string =>
  channel.slug ?? slugifyChannelName(channel.name);

/**
 * Channels from before Phase 7 (no `slug`) or without a usable creator: any
 * member may delete them, so old test data can be cleaned up.
 */
export function isLegacyChannel(channel: Pick<Channel, "type" | "slug" | "createdBy">): boolean {
  return channel.type !== "dm" && (!channel.slug || !channel.createdBy?.trim());
}

/**
 * Who may delete `channel`: never `#general`; either member of a DM; a
 * channel's creator — or any member when the channel is legacy or its creator
 * isn't a known user (`creatorKnown`, checked against the users directory).
 */
export function canDeleteChannel(
  channel: Pick<Channel, "channelId" | "type" | "slug" | "createdBy" | "members">,
  userId: string,
  creatorKnown: boolean,
): boolean {
  if (channel.channelId === GENERAL_CHANNEL_ID || !isChannelMember(channel, userId)) return false;
  if (channel.type === "dm" || channel.createdBy === userId) return true;
  return isLegacyChannel(channel) || !creatorKnown;
}

/**
 * Who may edit `channel`'s topic and description: its creator or an admin (a
 * member of it); `#general` (created by the system) only by admins; never a DM.
 */
export function canEditChannel(
  channel: Pick<Channel, "channelId" | "type" | "createdBy" | "members">,
  userId: string,
  role: Role | undefined,
): boolean {
  if (channel.type === "dm" || !isChannelMember(channel, userId)) return false;
  return channel.createdBy === userId || role === "admin";
}

/** Who may rename `channel`: its creator or an admin (a member of it); never `#general` or a DM. */
export function canRenameChannel(
  channel: Pick<Channel, "channelId" | "type" | "createdBy" | "members">,
  userId: string,
  role: Role | undefined,
): boolean {
  if (channel.channelId === GENERAL_CHANNEL_ID || channel.type === "dm") return false;
  if (!isChannelMember(channel, userId)) return false;
  return channel.createdBy === userId || role === "admin";
}

// ---------------------------------------------------------------------------
// Client → server actions
// ---------------------------------------------------------------------------

export const MessageActionSchema = z.object({
  action: z.literal("message"),
  channelId,
  text: z.string().max(MAX_TEXT_LENGTH),
  attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  clientId: z.string().min(1).max(64),
  /** A secret (text only): stored with a 7-day TTL and shown masked. */
  isSecret: z.boolean().optional(),
  /** Answers this message of the same channel (the server copies a snapshot of it). */
  replyTo: z
    .object({ messageId: z.string().min(1).max(64), sk: z.string().min(1).max(128) })
    .optional(),
});

export const HistoryActionSchema = z.object({
  action: z.literal("history"),
  channelId,
  cursor: z.string().min(1).max(2048).optional(),
});

export const ChannelListActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("list"),
});

/** Trimmed, 1–40 chars, no control characters, and must yield a non-empty slug. */
export const ChannelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHANNEL_NAME_LENGTH)
  .refine((v) => !/\p{Cc}/u.test(v), "channel name cannot contain control characters")
  .refine(
    (v) => slugifyChannelName(v).length > 0,
    "channel name needs at least one letter or number",
  );

/**
 * The board of a project channel: link one the caller can see, or have the
 * server create one named after the channel (in the same transaction as the
 * channel, so neither exists without the other).
 */
export const ProjectBoardSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("link"), boardId: z.string().min(1).max(128) }),
  z.object({ mode: z.literal("create") }),
]);
export type ProjectBoard = z.infer<typeof ProjectBoardSchema>;

export const ChannelCreateActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("create"),
  /** Human-readable; the server derives the unique slug from it. */
  name: ChannelNameSchema,
  /** Defaults to `private`: only the creator (and later invitees) can see it. */
  visibility: z.enum(["public", "private"]).default("private"),
  /** Marks the channel as a project; `board` says which board (required then). */
  isProject: z.boolean().default(false),
  board: ProjectBoardSchema.optional(),
});

export const ChannelDmActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("dm"),
  withUserId: z.string().min(1).max(128),
});

/** Cognito `sub`s; `_` is excluded because DM ids are `dm_<a>_<b>`. */
export const UserIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^_\s]+$/, "user ids cannot contain '_' or whitespace");
const userId = UserIdSchema;

export const ChannelInviteActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("invite"),
  channelId,
  userIds: z.array(userId).min(1).max(MAX_INVITES_PER_REQUEST),
});

/**
 * Deletes a channel (its creator only; never `#general`) or a DM (either member),
 * together with its messages.
 */
export const ChannelDeleteActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("delete"),
  channelId,
});

/**
 * Renames a channel (its creator or an admin; never `#general`). The slug, and
 * so the channel id, stays: links and history keep working.
 */
/** Older clients' rename; same as `update` with only a name. */
export const ChannelRenameActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("rename"),
  channelId,
  name: ChannelNameSchema,
});

/** Edits the given fields (at least one); `""` clears the topic or description. */
export const ChannelUpdateActionSchema = z
  .object({
    action: z.literal("channel"),
    op: z.literal("update"),
    channelId,
    name: ChannelNameSchema.optional(),
    topic: z
      .string()
      .trim()
      .max(MAX_CHANNEL_TOPIC_LENGTH)
      .refine((v) => !/\p{Cc}/u.test(v), "topic cannot contain control characters")
      .optional(),
    description: z
      .string()
      .trim()
      .max(MAX_CHANNEL_DESCRIPTION_LENGTH)
      // Line breaks are fine; other control characters are not.
      .refine((v) => !/[^\P{Cc}\n]/u.test(v), "description cannot contain control characters")
      .optional(),
    /** `true` needs `board` (unless the channel already has one); `false` unlinks the board. */
    isProject: z.boolean().optional(),
    board: ProjectBoardSchema.optional(),
  })
  .refine(
    (a) =>
      a.name !== undefined ||
      a.topic !== undefined ||
      a.description !== undefined ||
      a.isProject !== undefined ||
      a.board !== undefined,
    "nothing to update",
  );

export const ChannelActionSchema = z.discriminatedUnion("op", [
  ChannelListActionSchema,
  ChannelRenameActionSchema,
  ChannelUpdateActionSchema,
  ChannelCreateActionSchema,
  ChannelDmActionSchema,
  ChannelInviteActionSchema,
  ChannelDeleteActionSchema,
]);

export const PresignPutActionSchema = z.object({
  action: z.literal("presign"),
  op: z.literal("put"),
  requestId,
  channelId,
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
});

export const PresignGetActionSchema = z.object({
  action: z.literal("presign"),
  op: z.literal("get"),
  requestId,
  key: z.string().min(1).max(1024),
});

export const PresignActionSchema = z.discriminatedUnion("op", [
  PresignPutActionSchema,
  PresignGetActionSchema,
]);

export const TypingActionSchema = z.object({
  action: z.literal("typing"),
  channelId,
});

/** "I have seen up to this message": moves the caller's watermark forward (never back). */
export const ReadActionSchema = z.object({
  action: z.literal("read"),
  channelId,
  sk: z.string().min(1).max(128),
});

/** Replace the text of one of the caller's own messages (attachments stay as they are). */
export const EditActionSchema = z.object({
  action: z.literal("edit"),
  channelId,
  sk: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

/** Trimmed, 1–40 chars, no control characters. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DISPLAY_NAME_LENGTH)
  .refine((v) => !/\p{Cc}/u.test(v), "display name cannot contain control characters");

export const UserListActionSchema = z.object({
  action: z.literal("user"),
  op: z.literal("list"),
});

export const UserUpdateActionSchema = z.object({
  action: z.literal("user"),
  op: z.literal("update"),
  displayName: DisplayNameSchema,
});

/** Most conversations one person can pin to the top of their DM list. */
export const MAX_PINNED_CHATS = 20;

/** Pins (or unpins) a conversation for the caller only; synced to their other devices. */
export const UserPinActionSchema = z.object({
  action: z.literal("user"),
  op: z.literal("pin"),
  channelId,
  pinned: z.boolean(),
});

export const UserActionSchema = z.discriminatedUnion("op", [
  UserListActionSchema,
  UserUpdateActionSchema,
  UserPinActionSchema,
]);

/** A single emoji (possibly a multi-code-point sequence): no whitespace or control chars. */
export const EmojiSchema = z
  .string()
  .min(1)
  .max(MAX_EMOJI_LENGTH)
  .refine((v) => !/[\s\p{Cc}]/u.test(v), "invalid emoji");

/** Adds or removes the caller's reaction on the message `channelId` + `sk`. */
export const ReactActionSchema = z.object({
  action: z.literal("react"),
  channelId,
  sk: z.string().min(1).max(128),
  emoji: EmojiSchema,
  op: z.enum(["add", "remove"]),
});

// --- WebRTC signaling (1:1 calls in DMs; the server only relays, media is P2P) ---

export const CALL_MEDIA = ["audio", "video"] as const;
export type CallMedia = (typeof CALL_MEDIA)[number];

/** Why a call ended or was declined, as shown to the other side. */
export const CALL_END_REASONS = [
  "hangup",
  "cancelled",
  "declined",
  "busy",
  "no_answer",
  "unavailable",
  "failed",
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

const callBase = {
  action: z.literal("call"),
  /** Chosen by the caller; ties every signal of one call together. */
  callId: z.string().min(1).max(64),
  /** The DM the call belongs to: calls are 1:1 between its two members. */
  channelId,
  /** User id of the other participant. */
  to: userId,
};

const sdp = z.string().min(1).max(MAX_SDP_LENGTH);

export const CallOfferSchema = z.object({
  ...callBase,
  signal: z.literal("offer"),
  media: z.enum(CALL_MEDIA),
  sdp,
});

export const CallAnswerSchema = z.object({ ...callBase, signal: z.literal("answer"), sdp });

/** Mirrors `RTCIceCandidateInit`. */
export const IceCandidateSchema = z.object({
  candidate: z.string().max(MAX_ICE_CANDIDATE_LENGTH),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export type IceCandidate = z.infer<typeof IceCandidateSchema>;

export const CallIceCandidateSchema = z.object({
  ...callBase,
  signal: z.literal("ice_candidate"),
  candidate: IceCandidateSchema,
});

export const CallEndSchema = z.object({
  ...callBase,
  signal: z.literal("end"),
  reason: z.enum(CALL_END_REASONS).default("hangup"),
});

export const CallDeclineSchema = z.object({
  ...callBase,
  signal: z.literal("decline"),
  reason: z.enum(["declined", "busy"]).default("declined"),
});

export const CallActionSchema = z.discriminatedUnion("signal", [
  CallOfferSchema,
  CallAnswerSchema,
  CallIceCandidateSchema,
  CallEndSchema,
  CallDeclineSchema,
]);
export type CallAction = z.infer<typeof CallActionSchema>;
export type CallSignal = CallAction["signal"];

/**
 * Heartbeat: API Gateway drops WebSocket connections idle for 10 minutes, so
 * clients send this every few minutes. `active` says whether the app is in
 * front of the person (focused and visible); clients also send it right away
 * when that changes. The server pushes to phones only while no device of the
 * person is active (see `ACTIVE_WINDOW_MS`).
 */
export const PingActionSchema = z.object({
  action: z.literal("ping"),
  active: z.boolean().optional(),
});

export type ReadAction = z.infer<typeof ReadActionSchema>;
export type EditAction = z.infer<typeof EditActionSchema>;

export const ClientActionSchema = z.union([
  MessageActionSchema,
  HistoryActionSchema,
  ChannelActionSchema,
  PresignActionSchema,
  TypingActionSchema,
  UserActionSchema,
  ReactActionSchema,
  CallActionSchema,
  PingActionSchema,
  ReadActionSchema,
  EditActionSchema,
]);

export type MessageAction = z.infer<typeof MessageActionSchema>;
export type HistoryAction = z.infer<typeof HistoryActionSchema>;
export type ChannelAction = z.infer<typeof ChannelActionSchema>;
export type PresignAction = z.infer<typeof PresignActionSchema>;
export type TypingAction = z.infer<typeof TypingActionSchema>;
export type UserAction = z.infer<typeof UserActionSchema>;
export type ReactAction = z.infer<typeof ReactActionSchema>;
export type ClientAction = z.infer<typeof ClientActionSchema>;
/** What a client may send: like `ClientAction`, but fields with defaults are optional. */
export type ClientActionInput = z.input<typeof ClientActionSchema>;

/**
 * Parses a raw WebSocket frame body against `schema`.
 * Invalid JSON and schema mismatches both yield `{ success: false }`.
 */
export function parseAction<T extends z.ZodType>(
  schema: T,
  body: string | null | undefined,
): { success: true; data: z.infer<T> } | { success: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    return { success: false, error: "Invalid JSON" };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: z.prettifyError(result.error) };
}

// ---------------------------------------------------------------------------
// Server → client events
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_NAME_TAKEN"
  | "FORBIDDEN"
  | "USER_NOT_FOUND"
  | "RATE_LIMITED"
  | "MESSAGE_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "BOARD_NOT_FOUND"
  | "INTERNAL_ERROR";

export interface MessageNewEvent {
  type: "message.new";
  message: Message;
  clientId: string;
}

export interface HistoryPageEvent {
  type: "history.page";
  channelId: string;
  /** Chronological (ascending) order. */
  items: Message[];
  /** Opaque cursor for the next (older) page, `null` when there is none. */
  nextCursor: string | null;
}

/** Unread badges stop counting here (shown as "99+"). */
export const MAX_UNREAD_COUNT = 99;

export interface ChannelListEvent {
  type: "channel.list";
  channels: Channel[];
  /**
   * Your unread count per channel (messages from others after your read mark,
   * up to `MAX_UNREAD_COUNT + 1`). Only in the reply to your own `list`; the
   * lists broadcast after a change leave it out, and clients keep their counts.
   */
  unread?: Record<string, number>;
}

export interface PresignResultEvent {
  type: "presign.result";
  url: string;
  key: string;
  requestId: string;
}

export interface ErrorEvent {
  type: "error";
  code: ErrorCode;
  message?: string;
  requestId?: string;
}

export interface MessageReactionEvent {
  type: "message.reaction";
  channelId: string;
  sk: string;
  messageId: string;
  /** Full, current reactions of the message. */
  reactions: Record<string, string[]>;
}

/** The author edited a message: its new text (everything else is unchanged). */
export interface MessageUpdatedEvent {
  type: "message.updated";
  channelId: string;
  sk: string;
  messageId: string;
  text: string;
  isEdited: true;
  editedAt: number;
}

/** `userId` has read `channelId` up to `sk` (their watermark moved forward). */
export interface ChannelReadEvent {
  type: "channel.read";
  channelId: string;
  userId: string;
  sk: string;
  at: number;
}

/** `userId` is typing in `channelId` (sent at most every few seconds; nothing is stored). */
export interface UserTypingEvent {
  type: "user.typing";
  channelId: string;
  userId: string;
}

export interface UserListEvent {
  type: "user.list";
  users: UserProfile[];
  /** Ids of users with at least one live connection (presence snapshot). */
  online?: string[];
}

/** A user opened a connection (another tab or device counts too). */
export interface UserConnectedEvent {
  type: "user.connected";
  userId: string;
}

/** A user's last live connection closed. */
export interface UserDisconnectedEvent {
  type: "user.disconnected";
  userId: string;
}

/** Sent to everyone who could see the channel; clients drop it and leave it if open. */
export interface ChannelDeletedEvent {
  type: "channel.deleted";
  channelId: string;
  /** Who deleted it. */
  by: string;
}

export interface UserUpdatedEvent {
  type: "user.updated";
  user: UserProfile;
}

/** The caller's own preferences (only ever sent to their own connections). */
export interface UserPrefsEvent {
  type: "user.prefs";
  /** Conversations pinned to the top of the DM list, most recent pin first. */
  pinned: string[];
}

/** A channel changed (renamed): its new row, for everyone who can see it. */
export interface ChannelUpdatedEvent {
  type: "channel.updated";
  channel: Channel;
}

/** Fields every relayed call signal carries; `from` is set by the server. */
interface CallEventBase {
  callId: string;
  channelId: string;
  from: string;
}

export interface CallOfferEvent extends CallEventBase {
  type: "call.offer";
  media: CallMedia;
  sdp: string;
}

export interface CallAnswerEvent extends CallEventBase {
  type: "call.answer";
  sdp: string;
}

export interface CallIceCandidateEvent extends CallEventBase {
  type: "call.ice_candidate";
  candidate: IceCandidate;
}

export interface CallEndEvent extends CallEventBase {
  type: "call.end";
  reason: CallEndReason;
}

export interface CallDeclineEvent extends CallEventBase {
  type: "call.decline";
  reason: "declined" | "busy";
}

export type CallEvent =
  CallOfferEvent | CallAnswerEvent | CallIceCandidateEvent | CallEndEvent | CallDeclineEvent;

/** Task Manager pushes (Phase 6.1): sent to the board's members after an HTTP write. */
export interface BoardTaskCreatedEvent {
  type: "board.task_created";
  boardId: string;
  task: Task;
  /** Who created it (absent from older servers). */
  by?: string;
  /** For the notification text. */
  boardName?: string;
}
export interface BoardTaskUpdatedEvent {
  type: "board.task_updated";
  boardId: string;
  task: Task;
  /** Who changed it (absent from older servers). */
  by?: string;
  boardName?: string;
  /** Set when this change moved the task to another column (`task.status` is the new one). */
  previousStatus?: TaskStatus;
}
export interface BoardTaskDeletedEvent {
  type: "board.task_deleted";
  boardId: string;
  taskId: string;
}
/** Members changed (the board itself, with its full member list). */
export interface BoardUpdatedEvent {
  type: "board.updated";
  board: Board;
}
/** The owner deleted the board (and its tasks). */
export interface BoardDeletedEvent {
  type: "board.deleted";
  boardId: string;
}
export type BoardEvent =
  | BoardTaskCreatedEvent
  | BoardTaskUpdatedEvent
  | BoardTaskDeletedEvent
  | BoardUpdatedEvent
  | BoardDeletedEvent;

export type ServerEvent =
  | MessageNewEvent
  | MessageReactionEvent
  | MessageUpdatedEvent
  | ChannelReadEvent
  | UserTypingEvent
  | HistoryPageEvent
  | ChannelListEvent
  | ChannelDeletedEvent
  | PresignResultEvent
  | UserListEvent
  | UserUpdatedEvent
  | UserPrefsEvent
  | ChannelUpdatedEvent
  | UserConnectedEvent
  | UserDisconnectedEvent
  | CallEvent
  | BoardEvent
  | CalendarPushEvent
  | ErrorEvent;

export type ServerEventType = ServerEvent["type"];
