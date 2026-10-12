import { z } from "zod";

// ---------------------------------------------------------------------------
// Limits & constants
// ---------------------------------------------------------------------------

export const MAX_TEXT_LENGTH = 4000;
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const CHANNEL_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
export const HISTORY_PAGE_SIZE = 50;
export const PRESIGN_EXPIRES_SECONDS = 300;
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
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** `private` channels and `dm`s are visible only to their `members`. */
export type ChannelType = "public" | "private" | "dm";
export type ChannelVisibility = Extract<ChannelType, "public" | "private">;

export interface Channel {
  channelId: string;
  name: string;
  type: ChannelType;
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  archived: boolean;
  /** `private` and `dm` channels: user ids allowed to see the channel. */
  members?: string[];
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
}

export interface UserProfile {
  userId: string;
  email: string;
  /** Primary identifier in the UI; defaults to the local part of the email. */
  displayName: string;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** Whether `userId` may see `channel`: public channels are open, others need membership. */
export function isChannelMember(
  channel: Pick<Channel, "type" | "members">,
  userId: string,
): boolean {
  return channel.type === "public" || (channel.members ?? []).includes(userId);
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

export const ChannelCreateActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("create"),
  name: z.string().regex(CHANNEL_NAME_PATTERN),
  /** Defaults to `private`: only the creator (and later invitees) can see it. */
  visibility: z.enum(["public", "private"]).default("private"),
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

export const ChannelActionSchema = z.discriminatedUnion("op", [
  ChannelListActionSchema,
  ChannelCreateActionSchema,
  ChannelDmActionSchema,
  ChannelInviteActionSchema,
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

export const UserActionSchema = z.discriminatedUnion("op", [
  UserListActionSchema,
  UserUpdateActionSchema,
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
 * clients send this every few minutes. The server does nothing with it.
 */
export const PingActionSchema = z.object({ action: z.literal("ping") });

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
  | "MESSAGE_NOT_FOUND"
  | "FILE_NOT_FOUND"
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

export interface ChannelListEvent {
  type: "channel.list";
  channels: Channel[];
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

export interface UserListEvent {
  type: "user.list";
  users: UserProfile[];
}

export interface UserUpdatedEvent {
  type: "user.updated";
  user: UserProfile;
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

export type ServerEvent =
  | MessageNewEvent
  | MessageReactionEvent
  | HistoryPageEvent
  | ChannelListEvent
  | PresignResultEvent
  | UserListEvent
  | UserUpdatedEvent
  | CallEvent
  | ErrorEvent;

export type ServerEventType = ServerEvent["type"];
