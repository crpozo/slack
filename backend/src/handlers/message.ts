import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  MessageActionSchema,
  newMessageSk,
  parseAction,
  replyPreview,
  SECRET_PREVIEW,
  SECRET_TTL_MS,
  type Message,
  type MessageAction,
  type MessageNewEvent,
  type ReplySnapshot,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { activeUserIds, deliver, listConnections } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { notifyOffline } from "../lib/notify";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { signAttachments } from "../lib/s3";

/** How far back a resent message is recognized (its own retry window is seconds). */
const DEDUPE_WINDOW = 25;

/**
 * The message `userId` already stored under `clientId`, among the channel's
 * newest messages. A client retries with the same clientId when its first
 * send looked lost (a slow confirmation, a dropped connection, a queued frame
 * flushed on reconnect): storing it again would post the message twice.
 */
async function alreadyStored(
  channelId: string,
  userId: string,
  clientId: string,
): Promise<Message | null> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: tables.messages,
      KeyConditionExpression: "channelId = :c",
      ExpressionAttributeValues: { ":c": channelId },
      ScanIndexForward: false,
      Limit: DEDUPE_WINDOW,
    }),
  );
  const found = (Items ?? []).find((m) => m.clientId === clientId && m.userId === userId);
  return (found as Message | undefined) ?? null;
}

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
      ProjectionExpression: "messageId, sk, userId, #text, attachments, isSecret",
      ExpressionAttributeNames: { "#text": "text" },
    }),
  );
  const original = Item as
    Pick<Message, "messageId" | "sk" | "userId" | "text" | "attachments" | "isSecret"> | undefined;
  if (!original || original.messageId !== replyTo.messageId) return null;
  return {
    messageId: original.messageId,
    sk: original.sk,
    userId: original.userId,
    // A quote must never carry a secret's text.
    preview: original.isSecret ? SECRET_PREVIEW : replyPreview(original.text ?? ""),
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
  const { channelId, text, attachments = [], clientId, replyTo, isSecret } = parsed.data;

  if (!text.trim() && attachments.length === 0) {
    return badRequest(caller.connectionId, "Message is empty");
  }
  if (isSecret && (!text.trim() || attachments.length > 0)) {
    return badRequest(caller.connectionId, "A secret is text only");
  }
  const prefix = `attachments/${channelId}/`;
  const ownKey = (key: string) => key.startsWith(prefix) && !key.includes("..");
  if (attachments.some((a) => !ownKey(a.key) || (a.thumbKey && !ownKey(a.thumbKey)))) {
    return badRequest(caller.connectionId, "Attachment does not belong to this channel");
  }

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  const quoted = replyTo ? await replySnapshot(channelId, replyTo) : null;
  if (replyTo && !quoted) return replyError(caller.connectionId, "MESSAGE_NOT_FOUND");

  // A retry of a message that did arrive: confirm it to the sender, store nothing.
  const existing = await alreadyStored(channelId, caller.userId, clientId);
  if (existing) {
    log.info("duplicate send ignored", { channelId, messageId: existing.messageId });
    await reply(caller.connectionId, {
      type: "message.new",
      message: await signAttachments(existing),
      clientId,
    });
    return ok();
  }

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
    clientId,
    // TTL in seconds: DynamoDB deletes the row (and the secret with it) a week from now.
    ...(isSecret && { isSecret: true, expiresAt: Math.floor((now + SECRET_TTL_MS) / 1000) }),
  };
  await ddb.send(new PutCommand({ TableName: tables.messages, Item: message }));
  log.info("message stored", { channelId, messageId: message.messageId, userId: caller.userId });

  // Stored without URLs; sent with them (see `signAttachments`).
  const newMessage: MessageNewEvent = {
    type: "message.new",
    message: await signAttachments(message),
    clientId,
  };
  const inAudience = channelAudience(channel);
  const connections = await listConnections();
  await deliver(connections, (connection) => (inAudience(connection) ? newMessage : null));
  await notifyOffline(channel, message, activeUserIds(connections));
  return ok();
});
