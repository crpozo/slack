import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseAction, ReactActionSchema } from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { toReactionLists } from "../lib/messages";
import { badRequest, ok, replyError } from "../lib/response";

type MessageKey = { channelId: string; sk: string };
type Item = Record<string, unknown>;

/** ADD/DELETE the caller on `reactions.<emoji>` (a string set) of an existing message. */
async function updateReactionSet(
  key: MessageKey,
  emoji: string,
  userId: string,
  op: "add" | "remove",
): Promise<Item | undefined> {
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.messages,
      Key: key,
      UpdateExpression: `${op === "add" ? "ADD" : "DELETE"} #reactions.#emoji :user`,
      ConditionExpression: "attribute_exists(sk) AND attribute_exists(#reactions)",
      ExpressionAttributeNames: { "#reactions": "reactions", "#emoji": emoji },
      ExpressionAttributeValues: { ":user": new Set([userId]) },
      ReturnValues: "ALL_NEW",
    }),
  );
  return Attributes;
}

/** First reaction on a message stored before reactions existed: create the map. */
async function initReactions(
  key: MessageKey,
  emoji: string,
  userId: string,
): Promise<Item | undefined> {
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.messages,
      Key: key,
      UpdateExpression: "SET #reactions = :reactions",
      ConditionExpression: "attribute_exists(sk) AND attribute_not_exists(#reactions)",
      ExpressionAttributeNames: { "#reactions": "reactions" },
      ExpressionAttributeValues: { ":reactions": { [emoji]: new Set([userId]) } },
      ReturnValues: "ALL_NEW",
    }),
  );
  return Attributes;
}

async function getMessage(key: MessageKey): Promise<Item | undefined> {
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.messages, Key: key }));
  return Item;
}

const isConditionFailure = (err: unknown) => err instanceof ConditionalCheckFailedException;

/**
 * Applies the reaction idempotently (sets ignore duplicates and missing
 * members) and returns the updated message, or `undefined` if it doesn't exist.
 */
async function applyReaction(
  key: MessageKey,
  emoji: string,
  userId: string,
  op: "add" | "remove",
): Promise<Item | undefined> {
  try {
    return await updateReactionSet(key, emoji, userId, op);
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
  // The message is missing, or predates reactions (no `reactions` map yet).
  if (op === "remove") return getMessage(key);
  try {
    return await initReactions(key, emoji, userId);
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
  // Someone else created the map in between (or the message is gone): retry once.
  try {
    return await updateReactionSet(key, emoji, userId, op);
  } catch (err) {
    if (isConditionFailure(err)) return undefined;
    throw err;
  }
}

/** `react`: add or remove the caller's emoji reaction and broadcast `message.reaction`. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(ReactActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, sk, emoji, op } = parsed.data;

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");

  const message = await applyReaction({ channelId, sk }, emoji, caller.userId, op);
  if (!message) return replyError(caller.connectionId, "MESSAGE_NOT_FOUND");
  log.info("reaction", { channelId, sk, op, userId: caller.userId });

  const inAudience = channelAudience(channel);
  await broadcast((connection) =>
    inAudience(connection)
      ? {
          type: "message.reaction",
          channelId,
          sk,
          messageId: String(message.messageId),
          reactions: toReactionLists(message.reactions),
        }
      : null,
  );
  return ok();
});
