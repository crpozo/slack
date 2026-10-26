import { paginateQuery, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  linkRows,
  mediaRows,
  MEDIA_PAGE_SIZE,
  pinRow,
  type Attachment,
  type ChannelFile,
  type ChannelLink,
  type FileRow,
  type IndexedMessage,
  type LinkRow,
  type MediaKind,
  type MediaRow,
  type Message,
  type MessagePinnedEvent,
  type PinRow,
} from "@mindfultech/shared";
import { batchDelete, batchPut, ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";

// ---------------------------------------------------------------------------
// The `channel-media` index (Phase 38): writing and reading it. The rows and
// their keys are defined in @mindfultech/shared (media.ts), which the
// backfill script uses too.
// ---------------------------------------------------------------------------

export type { FileRow, LinkRow, MediaKind, MediaRow, PinRow };

const keyOf = (row: { channelId: string; sk: string }) => ({
  channelId: row.channelId,
  sk: row.sk,
});

/** Transaction items that index a new message with it (none for most messages). */
export function mediaPuts(message: IndexedMessage) {
  return mediaRows(message).map((Item) => ({
    Put: { TableName: tables.channelMedia, Item },
  }));
}

/**
 * Removes what `messages` (as they were before being deleted or emptied) put
 * in the index: their files and links, and their pins, the channel's count
 * going down with them. Best effort, logged, never failing the deletion.
 * @returns a `message.pinned` (unpinned) event per pin that went.
 */
export async function forgetMessages(
  messages: Array<IndexedMessage & Pick<Message, "pinnedAt" | "pinnedBy">>,
): Promise<MessagePinnedEvent[]> {
  const keys = messages.flatMap((m) => [
    ...mediaRows({ ...m, deletedAt: undefined }).map(keyOf),
    ...(m.pinnedAt ? [keyOf(pinRow(m, m.pinnedAt, m.pinnedBy ?? ""))] : []),
  ]);
  if (keys.length === 0) return [];
  try {
    await batchDelete(tables.channelMedia, keys);
  } catch (err) {
    log.error("media index not cleaned up", { rows: keys.length, ...errorFields(err) });
  }
  const events: MessagePinnedEvent[] = [];
  for (const m of messages.filter((m) => m.pinnedAt)) {
    try {
      const pinCount = await changePinCount(m.channelId, -1);
      events.push({
        type: "message.pinned",
        channelId: m.channelId,
        sk: m.sk,
        messageId: m.messageId,
        pinCount,
      });
    } catch (err) {
      log.warn("pin count not lowered", { channelId: m.channelId, ...errorFields(err) });
    }
  }
  return events;
}

/**
 * After an edit: the message's link rows follow its new text. Best effort
 * (the edit is already stored); a later edit or the backfill fixes a miss.
 */
export async function reindexLinks(before: IndexedMessage, text: string): Promise<void> {
  const old = linkRows(before).map(keyOf);
  const fresh = linkRows({ ...before, text });
  const freshKeys = new Set(fresh.map((r) => r.sk));
  try {
    await batchDelete(
      tables.channelMedia,
      old.filter((k) => !freshKeys.has(k.sk)),
    );
    // Rewritten even when the URL stayed: the snippet shows the new text.
    if (fresh.length > 0)
      await batchPut(tables.channelMedia, fresh as unknown as Record<string, unknown>[]);
  } catch (err) {
    log.error("link index not updated after an edit", {
      channelId: before.channelId,
      ...errorFields(err),
    });
  }
}

/** Adds `delta` to the channel's pin count, never below zero. */
export async function changePinCount(channelId: string, delta: 1 | -1): Promise<number> {
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.channels,
      Key: { channelId },
      UpdateExpression: "ADD pinCount :d",
      ConditionExpression:
        delta < 0
          ? "attribute_exists(channelId) AND pinCount > :zero"
          : "attribute_exists(channelId)",
      ExpressionAttributeValues: { ":d": delta, ...(delta < 0 && { ":zero": 0 }) },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return Number(Attributes?.pinCount ?? 0);
}

// --- Reading -------------------------------------------------------------------------

/** The page cursor: the last row read, opaque to clients. */
export function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;
}

/** A cursor for this conversation and kind, or `null` (ignored: the first page). */
export function decodeCursor(
  cursor: string | undefined,
  channelId: string,
  kind: string,
): Record<string, string> | null {
  if (!cursor) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      key &&
      typeof key === "object" &&
      (key as Record<string, unknown>).channelId === channelId &&
      typeof (key as Record<string, unknown>).sk === "string" &&
      String((key as Record<string, unknown>).sk).startsWith(`${kind}#`) &&
      Object.keys(key).length === 2
    ) {
      return key as Record<string, string>;
    }
  } catch {
    // fall through
  }
  return null;
}

/** One page of a conversation's files or links, newest first. */
export async function listMedia(
  channelId: string,
  kind: MediaKind,
  cursor: string | undefined,
  limit = MEDIA_PAGE_SIZE,
): Promise<{ rows: MediaRow[]; nextCursor: string | null }> {
  const start = decodeCursor(cursor, channelId, kind);
  const { Items, LastEvaluatedKey } = await ddb.send(
    new QueryCommand({
      TableName: tables.channelMedia,
      KeyConditionExpression: "channelId = :c AND begins_with(sk, :k)",
      ExpressionAttributeValues: { ":c": channelId, ":k": `${kind}#` },
      ScanIndexForward: false,
      Limit: limit,
      ...(start && { ExclusiveStartKey: start }),
    }),
  );
  return { rows: (Items ?? []) as MediaRow[], nextCursor: encodeCursor(LastEvaluatedKey) };
}

/** A conversation's pin rows, most recently pinned first. */
export async function listPins(channelId: string): Promise<PinRow[]> {
  const rows: PinRow[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.channelMedia,
      KeyConditionExpression: "channelId = :c AND begins_with(sk, :k)",
      ExpressionAttributeValues: { ":c": channelId, ":k": "pin#" },
      ScanIndexForward: false,
    },
  )) {
    rows.push(...((page.Items ?? []) as PinRow[]));
  }
  return rows;
}

/** Everything a deleted conversation had in the index. */
export async function forgetChannel(channelId: string): Promise<number> {
  const keys: Array<{ channelId: string; sk: string }> = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.channelMedia,
      KeyConditionExpression: "channelId = :c",
      ExpressionAttributeValues: { ":c": channelId },
      ProjectionExpression: "channelId, sk",
    },
  )) {
    keys.push(...((page.Items ?? []) as typeof keys));
  }
  await batchDelete(tables.channelMedia, keys);
  return keys.length;
}

/** A row as sent to clients (files signed by the caller, see `signAttachments`). */
export function toChannelFile(row: FileRow, attachment: Attachment): ChannelFile {
  return {
    channelId: row.channelId,
    messageId: row.messageId,
    messageSk: row.messageSk,
    ...(row.parentSk && { parentSk: row.parentSk }),
    userId: row.userId,
    createdAt: row.createdAt,
    attachment,
  };
}

export function toChannelLink(row: LinkRow): ChannelLink {
  return {
    channelId: row.channelId,
    messageId: row.messageId,
    messageSk: row.messageSk,
    ...(row.parentSk && { parentSk: row.parentSk }),
    userId: row.userId,
    createdAt: row.createdAt,
    url: row.url,
    domain: row.domain,
    snippet: row.snippet,
  };
}
