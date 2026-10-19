import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  HISTORY_PAGE_SIZE,
  HistoryActionSchema,
  isExpired,
  parseAction,
  THREAD_SK_PREFIX,
  threadSkPrefix,
} from "@mindfultech/shared";
import { getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { toWireMessage } from "../lib/messages";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { signAttachments } from "../lib/s3";

type MessageKey = { channelId: string; sk: string };

export function encodeCursor(key: MessageKey): string {
  return Buffer.from(JSON.stringify({ channelId: key.channelId, sk: key.sk })).toString(
    "base64url",
  );
}

/** Decodes a cursor and checks it belongs to `channelId`; `null` if invalid. */
export function decodeCursor(cursor: string, channelId: string): MessageKey | null {
  try {
    const key: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof key === "object" &&
      key !== null &&
      "channelId" in key &&
      "sk" in key &&
      key.channelId === channelId &&
      typeof key.sk === "string"
    ) {
      return { channelId, sk: key.sk };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * `history`: one page of messages, newest first from DynamoDB, returned
 * ascending, image and audio attachments carrying signed download URLs.
 * With `thread`, one page of that message's replies instead (ascending).
 */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(HistoryActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, cursor, thread } = parsed.data;

  let exclusiveStartKey: MessageKey | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor, channelId);
    if (!decoded) return badRequest(caller.connectionId, "Invalid cursor");
    exclusiveStartKey = decoded;
  }

  // Archived channels stay readable (that's what archived means).
  if (!(await getAccessibleChannel(channelId, caller.userId, { allowArchived: true }))) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }

  // The channel: top-level rows only (every reply sorts after `thread#`),
  // newest first. A thread: its replies, oldest first.
  const page = await ddb.send(
    new QueryCommand({
      TableName: tables.messages,
      KeyConditionExpression: thread
        ? "channelId = :c AND begins_with(sk, :prefix)"
        : "channelId = :c AND sk < :prefix",
      ExpressionAttributeValues: {
        ":c": channelId,
        ":prefix": thread ? threadSkPrefix(thread.sk) : THREAD_SK_PREFIX,
      },
      ScanIndexForward: !!thread,
      Limit: HISTORY_PAGE_SIZE,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  // Expired secrets wait for DynamoDB's sweep; readers don't. Inline attachments
  // leave with their download URLs: no presign round trip per image.
  const now = Date.now();
  const ordered = (page.Items ?? []).map(toWireMessage).filter((m) => !isExpired(m, now));
  if (!thread) ordered.reverse();
  const items = await Promise.all(ordered.map((m) => signAttachments(m)));
  const last = page.LastEvaluatedKey as MessageKey | undefined;
  await reply(caller.connectionId, {
    type: "history.page",
    channelId,
    ...(thread && { thread }),
    items,
    nextCursor: last ? encodeCursor(last) : null,
  });
  return ok();
});
