import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  isThreadSk,
  MAX_THREAD_AVATARS,
  MessageActionSchema,
  newMessageSk,
  parseAction,
  replyPreview,
  SECRET_PREVIEW,
  SECRET_TTL_MS,
  threadSkPrefix,
  type Message,
  type MessageAction,
  type MessageNewEvent,
  type MessageThreadUpdatedEvent,
  type ReplySnapshot,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { activeUserIds, deliver, listConnections } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { findSentMessage } from "../lib/messages";
import { notifyOffline } from "../lib/notify";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { signAttachments } from "../lib/s3";

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
 * Stores a thread reply and bumps its parent's counters in one transaction:
 * the parent must exist, be the message the client named, and be top-level,
 * so a reply never dangles and threads never nest. `replyUserIds` keeps the
 * newest `MAX_THREAD_AVATARS` distinct repliers (the reply's author last).
 * @returns the parent's new counters, or `null` when there is no such parent.
 */
async function storeReply(
  message: Message,
  thread: { messageId: string; sk: string },
  userId: string,
  now: number,
): Promise<MessageThreadUpdatedEvent | null> {
  const { channelId } = message;
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.messages,
      Key: { channelId, sk: thread.sk },
      ProjectionExpression: "messageId, parentSk, replyCount, replyUserIds",
    }),
  );
  if (!Item || Item.messageId !== thread.messageId || Item.parentSk) return null;
  const previous = Array.isArray(Item.replyUserIds) ? (Item.replyUserIds as string[]) : [];
  const replyUserIds = [...previous.filter((id) => id !== userId), userId].slice(
    -MAX_THREAD_AVATARS,
  );
  const replyCount = (typeof Item.replyCount === "number" ? Item.replyCount : 0) + 1;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.messages,
              Item: message,
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          {
            Update: {
              TableName: tables.messages,
              Key: { channelId, sk: thread.sk },
              UpdateExpression: "SET replyCount = :count, lastReplyAt = :now, replyUserIds = :ids",
              // Still the same top-level parent; another reply in between just means
              // our count is stale, so the retry below recomputes it.
              ConditionExpression:
                "attribute_exists(sk) AND messageId = :id AND attribute_not_exists(parentSk) AND (attribute_not_exists(replyCount) OR replyCount = :was)",
              ExpressionAttributeValues: {
                ":count": replyCount,
                ":now": now,
                ":ids": replyUserIds,
                ":id": thread.messageId,
                ":was": replyCount - 1,
              },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || isTransactionCancelled(err)) {
      // Two replies raced: read the parent again and try once more.
      log.info("reply raced another; retrying", { channelId, parentId: thread.messageId });
      return storeReplyOnce(message, thread, userId, now);
    }
    log.error("reply transaction failed", { channelId, ...errorFields(err) });
    throw err;
  }
  return {
    type: "message.thread_updated",
    channelId,
    sk: thread.sk,
    messageId: thread.messageId,
    replyCount,
    lastReplyAt: now,
    replyUserIds,
  };
}

const isTransactionCancelled = (err: unknown) =>
  err instanceof Error && err.name === "TransactionCanceledException";

/** One more attempt after a race; a second failure surfaces as a 500 (the client retries). */
async function storeReplyOnce(
  message: Message,
  thread: { messageId: string; sk: string },
  userId: string,
  now: number,
): Promise<MessageThreadUpdatedEvent | null> {
  const { channelId } = message;
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.messages,
      Key: { channelId, sk: thread.sk },
      ProjectionExpression: "messageId, parentSk, replyCount, replyUserIds",
    }),
  );
  if (!Item || Item.messageId !== thread.messageId || Item.parentSk) return null;
  const previous = Array.isArray(Item.replyUserIds) ? (Item.replyUserIds as string[]) : [];
  const replyUserIds = [...previous.filter((id) => id !== userId), userId].slice(
    -MAX_THREAD_AVATARS,
  );
  const replyCount = (typeof Item.replyCount === "number" ? Item.replyCount : 0) + 1;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tables.messages, Item: message } },
        {
          Update: {
            TableName: tables.messages,
            Key: { channelId, sk: thread.sk },
            UpdateExpression: "SET replyCount = :count, lastReplyAt = :now, replyUserIds = :ids",
            ConditionExpression: "attribute_exists(sk) AND messageId = :id",
            ExpressionAttributeValues: {
              ":count": replyCount,
              ":now": now,
              ":ids": replyUserIds,
              ":id": thread.messageId,
            },
          },
        },
      ],
    }),
  );
  return {
    type: "message.thread_updated",
    channelId,
    sk: thread.sk,
    messageId: thread.messageId,
    replyCount,
    lastReplyAt: now,
    replyUserIds,
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
  const { channelId, text, attachments = [], clientId, replyTo, isSecret, thread } = parsed.data;

  if (!text.trim() && attachments.length === 0) {
    return badRequest(caller.connectionId, "Message is empty");
  }
  if (isSecret && (!text.trim() || attachments.length > 0)) {
    return badRequest(caller.connectionId, "A secret is text only");
  }
  // Threads hold ordinary messages: no secrets (their TTL sweep ignores counters),
  // and only top-level messages have threads (no nesting).
  if (thread && isSecret) return badRequest(caller.connectionId, "A secret can't be a reply");
  if (thread && isThreadSk(thread.sk)) {
    return badRequest(caller.connectionId, "Replies can't have threads of their own");
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
  const existing = await findSentMessage(channelId, caller.userId, clientId);
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
    sk: thread ? `${threadSkPrefix(thread.sk)}${newMessageSk(now)}` : newMessageSk(now),
    ...(thread && { parentId: thread.messageId, parentSk: thread.sk }),
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
  let parentCounters: MessageThreadUpdatedEvent | null = null;
  if (thread) {
    const counters = await storeReply(message, thread, caller.userId, now);
    if (!counters) return replyError(caller.connectionId, "MESSAGE_NOT_FOUND");
    parentCounters = counters;
  } else {
    await ddb.send(new PutCommand({ TableName: tables.messages, Item: message }));
  }
  log.info("message stored", {
    channelId,
    messageId: message.messageId,
    userId: caller.userId,
    ...(thread && { parentId: thread.messageId }),
  });

  // Stored without URLs; sent with them (see `signAttachments`).
  const newMessage: MessageNewEvent = {
    type: "message.new",
    message: await signAttachments(message),
    clientId,
  };
  const inAudience = channelAudience(channel);
  const connections = await listConnections();
  await deliver(connections, (connection) => (inAudience(connection) ? newMessage : null));
  if (parentCounters) {
    const counters = parentCounters;
    await deliver(connections, (connection) => (inAudience(connection) ? counters : null));
  }
  await notifyOffline(channel, message, activeUserIds(connections));
  return ok();
});
