import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { compareIds, type Message } from "@mindfultech/shared";
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
  return { ...(item as unknown as Message), reactions: toReactionLists(item.reactions) };
}

/** How far back a resent message is recognized (its own retry window is seconds). */
const DEDUPE_WINDOW = 25;

/**
 * The message `userId` already stored under `clientId`, among the channel's
 * newest messages. A client retries with the same clientId when its first
 * send looked lost (a slow confirmation, a dropped connection, a queued frame
 * flushed on reconnect): storing it again would post the message twice.
 */
export async function findSentMessage(
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
  return found ? toWireMessage(found) : null;
}
