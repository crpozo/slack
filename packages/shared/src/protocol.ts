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

/** Route keys of the WebSocket API (`$request.body.action`). */
export const CLIENT_ACTIONS = ["message", "history", "channel", "presign", "typing"] as const;
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

export type ChannelType = "public" | "dm";

export interface Channel {
  channelId: string;
  name: string;
  type: ChannelType;
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  archived: boolean;
  /** Only for `dm` channels: the two participant user ids. */
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
});

export const ChannelDmActionSchema = z.object({
  action: z.literal("channel"),
  op: z.literal("dm"),
  withUserId: z.string().min(1).max(128),
});

export const ChannelActionSchema = z.discriminatedUnion("op", [
  ChannelListActionSchema,
  ChannelCreateActionSchema,
  ChannelDmActionSchema,
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

export const ClientActionSchema = z.union([
  MessageActionSchema,
  HistoryActionSchema,
  ChannelActionSchema,
  PresignActionSchema,
  TypingActionSchema,
]);

export type MessageAction = z.infer<typeof MessageActionSchema>;
export type HistoryAction = z.infer<typeof HistoryActionSchema>;
export type ChannelAction = z.infer<typeof ChannelActionSchema>;
export type PresignAction = z.infer<typeof PresignActionSchema>;
export type TypingAction = z.infer<typeof TypingActionSchema>;
export type ClientAction = z.infer<typeof ClientActionSchema>;

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

export type ServerEvent =
  MessageNewEvent | HistoryPageEvent | ChannelListEvent | PresignResultEvent | ErrorEvent;

export type ServerEventType = ServerEvent["type"];
