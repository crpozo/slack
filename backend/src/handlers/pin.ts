import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  canPinMessage,
  MAX_PINS_PER_CHANNEL,
  parseAction,
  PinActionSchema,
  pinRow,
  type Channel,
  type Message,
  type MessagePinnedEvent,
} from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, replyError } from "../lib/response";

/**
 * `pin` (Phase 38): pins a message to its channel, or unpins it. Any member
 * can, up to `MAX_PINS_PER_CHANNEL` per channel; never a secret or a deleted
 * message, never in an archived channel. One transaction writes the message's
 * `pinnedAt`/`pinnedBy`, its row in the conversation's index (what the Pinned
 * panel lists) and the channel's `pinCount`; everyone in the channel hears
 * `message.pinned`. No message is posted about it.
 */

const isCancelled = (err: unknown) => err instanceof TransactionCanceledException;

async function pin(channel: Channel, message: Message, userId: string): Promise<number> {
  const pinnedAt = Date.now();
  const count = channel.pinCount ?? 0;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.messages,
            Key: { channelId: message.channelId, sk: message.sk },
            UpdateExpression: "SET pinnedAt = :at, pinnedBy = :by",
            ConditionExpression:
              "messageId = :id AND attribute_not_exists(pinnedAt) AND attribute_not_exists(deletedAt) AND attribute_not_exists(isSecret)",
            ExpressionAttributeValues: { ":at": pinnedAt, ":by": userId, ":id": message.messageId },
          },
        },
        { Put: { TableName: tables.channelMedia, Item: pinRow(message, pinnedAt, userId) } },
        {
          Update: {
            TableName: tables.channels,
            Key: { channelId: message.channelId },
            UpdateExpression: "ADD pinCount :one",
            ConditionExpression:
              "attribute_exists(channelId) AND (attribute_not_exists(pinCount) OR pinCount < :max)",
            ExpressionAttributeValues: { ":one": 1, ":max": MAX_PINS_PER_CHANNEL },
          },
        },
      ],
    }),
  );
  message.pinnedAt = pinnedAt;
  message.pinnedBy = userId;
  return count + 1;
}

async function unpin(channel: Channel, message: Message): Promise<number> {
  const pinnedAt = message.pinnedAt!;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.messages,
            Key: { channelId: message.channelId, sk: message.sk },
            UpdateExpression: "REMOVE pinnedAt, pinnedBy",
            ConditionExpression: "messageId = :id AND pinnedAt = :at",
            ExpressionAttributeValues: { ":id": message.messageId, ":at": pinnedAt },
          },
        },
        {
          Delete: {
            TableName: tables.channelMedia,
            Key: { channelId: message.channelId, sk: pinRow(message, pinnedAt, "").sk },
          },
        },
        {
          Update: {
            TableName: tables.channels,
            Key: { channelId: message.channelId },
            UpdateExpression: "ADD pinCount :minus",
            ConditionExpression: "attribute_exists(channelId) AND pinCount > :zero",
            ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
          },
        },
      ],
    }),
  );
  delete message.pinnedAt;
  delete message.pinnedBy;
  return Math.max(0, (channel.pinCount ?? 1) - 1);
}

export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(PinActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, sk, pinned } = parsed.data;

  const channel = await getAccessibleChannel(channelId, caller.userId, { allowArchived: true });
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  if (channel.archived) {
    return replyError(caller.connectionId, "FORBIDDEN", "This channel is archived");
  }
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.messages, Key: { channelId, sk } }),
  );
  const message = Item as Message | undefined;
  if (!message || message.deletedAt) return replyError(caller.connectionId, "MESSAGE_NOT_FOUND");
  if (!canPinMessage(message)) {
    return replyError(caller.connectionId, "FORBIDDEN", "Secrets can't be pinned");
  }
  // Already as asked (another member, or a retry): nothing to write.
  if (pinned === !!message.pinnedAt) return ok();
  if (pinned && (channel.pinCount ?? 0) >= MAX_PINS_PER_CHANNEL) {
    return replyError(
      caller.connectionId,
      "FORBIDDEN",
      `A conversation can have up to ${MAX_PINS_PER_CHANNEL} pinned messages. Unpin one first.`,
    );
  }

  let pinCount: number;
  try {
    pinCount = pinned ? await pin(channel, message, caller.userId) : await unpin(channel, message);
  } catch (err) {
    if (!isCancelled(err)) throw err;
    // The message changed meanwhile (deleted, or pinned/unpinned by someone else),
    // or the channel reached its limit: the clients' copies get there by themselves.
    const reasons = err.CancellationReasons ?? [];
    if (reasons[2]?.Code === "ConditionalCheckFailed" && pinned) {
      return replyError(
        caller.connectionId,
        "FORBIDDEN",
        `A conversation can have up to ${MAX_PINS_PER_CHANNEL} pinned messages. Unpin one first.`,
      );
    }
    log.info("pin raced another change", { channelId, sk });
    return replyError(caller.connectionId, "MESSAGE_NOT_FOUND");
  }
  log.info(pinned ? "message pinned" : "message unpinned", {
    channelId,
    messageId: message.messageId,
    userId: caller.userId,
  });

  const update: MessagePinnedEvent = {
    type: "message.pinned",
    channelId,
    sk,
    messageId: message.messageId,
    ...(message.pinnedAt && { pinnedAt: message.pinnedAt, pinnedBy: message.pinnedBy }),
    pinCount,
  };
  const inAudience = channelAudience(channel);
  await broadcast((connection) => (inAudience(connection) ? update : null));
  return ok();
});
