import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  compareIds,
  IMAGE_AT_ATTRIBUTE,
  imageAtOf,
  THREAD_SK_PREFIX,
  threadSkPrefix,
  type Message,
} from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

function userList(users: unknown): unknown[] {
  if (users instanceof Set) return [...users];
  return Array.isArray(users) ? users : [];
}

/** DynamoDB string sets come back as `Set`s; the wire format uses sorted arrays. */
export function toReactionLists(raw: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [emoji, users] of Object.entries(raw as Record<string, unknown>)) {
    const ids = userList(users)
      .filter((u): u is string => typeof u === "string")
      .sort(compareIds);
    if (ids.length > 0) result[emoji] = ids;
  }
  return result;
}

/** A `messages` row as sent to clients. */
export function toWireMessage(item: Record<string, unknown>): Message {
  // Phase 58: `transcribingAt` is the server's own hold while Whisper runs;
  // Phase 61: `imageAt` is the gallery index's key. Neither is the client's.
  const rest = { ...item };
  delete rest.transcribingAt;
  delete rest[IMAGE_AT_ATTRIBUTE];
  return { ...(rest as unknown as Message), reactions: toReactionLists(item.reactions) };
}

/**
 * A new message as stored (Phase 61): one with an image also carries
 * `imageAt`, which puts it in the gallery's sparse index (`IMAGE_INDEX`).
 * Every other message is stored without it, so the index never holds it.
 */
export function storedMessage(message: Message): Record<string, unknown> {
  const imageAt = imageAtOf(message);
  return imageAt ? { ...message, [IMAGE_AT_ATTRIBUTE]: imageAt } : { ...message };
}

/** How far back a resent message is recognized (its own retry window is seconds). */
const DEDUPE_WINDOW = 25;

/**
 * The message `userId` already stored under `clientId`, among the newest
 * messages of the channel (or, for a reply, of the thread under `parentSk`).
 * A client retries with the same clientId when its first send looked lost (a
 * slow confirmation, a dropped connection, a queued frame flushed on
 * reconnect): storing it again would post the message twice.
 *
 * The window is scoped by sort key: every `thread#…` row sorts after every
 * `<epochMs>#…` one, so an unscoped "newest 25" would be some thread's replies.
 */
export async function findSentMessage(
  channelId: string,
  userId: string,
  clientId: string,
  parentSk?: string,
): Promise<Message | null> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: tables.messages,
      KeyConditionExpression: parentSk
        ? "channelId = :c AND begins_with(sk, :p)"
        : "channelId = :c AND sk < :p",
      ExpressionAttributeValues: {
        ":c": channelId,
        ":p": parentSk ? threadSkPrefix(parentSk) : THREAD_SK_PREFIX,
      },
      ScanIndexForward: false,
      Limit: DEDUPE_WINDOW,
    }),
  );
  const found = (Items ?? []).find((m) => m.clientId === clientId && m.userId === userId);
  return found ? toWireMessage(found) : null;
}
