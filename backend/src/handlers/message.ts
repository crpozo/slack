import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  MessageActionSchema,
  newMessageSk,
  parseAction,
  REPLY_PREVIEW_LENGTH,
  type Message,
  type MessageAction,
  type MessageNewEvent,
  type ReplySnapshot,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, listConnections } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { notifyOffline } from "../lib/notify";
import { badRequest, ok, replyError } from "../lib/response";

/**
 * Snapshot of the message `replyTo` points at, which must exist in the same
 * channel (so a reply can never quote a channel the sender can't see).
 */
async function replySnapshot(
  channelId: string,
  replyTo: NonNullable<MessageAction["replyTo"]>,
): Promise<ReplySnapshot | null> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.messages,
      Key: { channelId, sk: replyTo.sk },
      ProjectionExpression: "messageId, sk, userId, #text, attachments",
      ExpressionAttributeNames: { "#text": "text" },
    }),
  );
  const original = Item as
    Pick<Message, "messageId" | "sk" | "userId" | "text" | "attachments"> | undefined;
  if (!original || original.messageId !== replyTo.messageId) return null;
  const text = (original.text ?? "").replace(/\s+/g, " ").trim();
  return {
    messageId: original.messageId,
    sk: original.sk,
    userId: original.userId,
    preview:
      text.length > REPLY_PREVIEW_LENGTH ? `${text.slice(0, REPLY_PREVIEW_LENGTH - 1)}…` : text,
    hasAttachments: (original.attachments ?? []).length > 0,
  };
}

/**
 * `message`: persists a message, fans it out as `message.new` to the channel's
 * audience, and sends a Web Push to recipients (the DM peer, or people
 * `@mentioned`) who have no live connection.
 */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(MessageActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, text, attachments = [], clientId, replyTo } = parsed.data;

  if (!text.trim() && attachments.length === 0) {
    return badRequest(caller.connectionId, "Message is empty");
  }
  if (attachments.some((a) => !a.key.startsWith(`attachments/${channelId}/`))) {
    return badRequest(caller.connectionId, "Attachment does not belong to this channel");
  }

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  const quoted = replyTo ? await replySnapshot(channelId, replyTo) : null;
  if (replyTo && !quoted) return replyError(caller.connectionId, "MESSAGE_NOT_FOUND");

  const now = Date.now();
  const message: Message = {
    messageId: ulid(now),
    channelId,
    sk: newMessageSk(now),
    userId: caller.userId,
    userEmail: caller.userEmail,
    text,
    attachments,
    createdAt: now,
    // An empty map up front lets `react` ADD to `reactions.<emoji>` directly.
    reactions: {},
    ...(quoted && { replyTo: quoted }),
  };
  await ddb.send(new PutCommand({ TableName: tables.messages, Item: message }));
  log.info("message stored", { channelId, messageId: message.messageId, userId: caller.userId });

  const newMessage: MessageNewEvent = { type: "message.new", message, clientId };
  const inAudience = channelAudience(channel);
  const connections = await listConnections();
  await deliver(connections, (connection) => (inAudience(connection) ? newMessage : null));
  await notifyOffline(channel, message, new Set(connections.map((c) => c.userId)));
  return ok();
});
