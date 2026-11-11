import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  IMAGE_AT_ATTRIBUTE,
  IMAGE_INDEX,
  isImageAttachment,
  MEDIA_WINDOW,
  type Attachment,
  type ChannelImage,
  type ChannelMediaWindow,
} from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

// ---------------------------------------------------------------------------
// The gallery's sliding window (Phase 61): two Queries of the messages
// table's sparse index `IMAGE_INDEX`, which only holds messages with images,
// each capped at `MEDIA_WINDOW` (+1) items. Every message in the index has at
// least one image, so 15 messages always cover 15 images: a window costs at
// most 31 index items read, and never a text message.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** The images of one indexed message, in the order it shows them. */
export function imagesOf(row: Row): ChannelImage[] {
  const { channelId, sk, messageId, userId, createdAt } = row;
  const imageAt = row[IMAGE_AT_ATTRIBUTE];
  if (
    typeof channelId !== "string" ||
    typeof sk !== "string" ||
    typeof messageId !== "string" ||
    typeof userId !== "string" ||
    typeof createdAt !== "number" ||
    typeof imageAt !== "string" ||
    !Array.isArray(row.attachments)
  ) {
    return [];
  }
  return (row.attachments as Attachment[]).flatMap((attachment, position) =>
    attachment && typeof attachment.contentType === "string" && isImageAttachment(attachment)
      ? [{ channelId, sk, messageId, userId, createdAt, imageAt, position, attachment }]
      : [],
  );
}

async function queryIndex(
  channelId: string,
  around: string,
  direction: "older" | "newer",
): Promise<{ rows: Row[]; more: boolean }> {
  const { Items, LastEvaluatedKey } = await ddb.send(
    new QueryCommand({
      TableName: tables.messages,
      IndexName: IMAGE_INDEX,
      KeyConditionExpression:
        direction === "older"
          ? "channelId = :c AND imageAt < :at"
          : "channelId = :c AND imageAt >= :at",
      ExpressionAttributeValues: { ":c": channelId, ":at": around },
      // Older: newest first, the ones right before the image; newer: from it on.
      ScanIndexForward: direction === "newer",
      // The opened image's own message comes first in "newer".
      Limit: direction === "older" ? MEDIA_WINDOW : MEDIA_WINDOW + 1,
    }),
  );
  return { rows: (Items ?? []) as Row[], more: LastEvaluatedKey !== undefined };
}

/**
 * Up to `MEDIA_WINDOW` images before the one opened (`around` is its
 * message's `imageAt`, `key` its attachment), it, and up to `MEDIA_WINDOW`
 * after, oldest first. Without the image (deleted since), the window is
 * still the images around that moment, with `index` -1. URLs aren't signed
 * here: the handler does it for what it returns.
 */
export async function mediaWindow(
  channelId: string,
  around: string,
  key?: string,
): Promise<ChannelMediaWindow> {
  const [older, newer] = await Promise.all([
    queryIndex(channelId, around, "older"),
    queryIndex(channelId, around, "newer"),
  ]);
  const before = older.rows.reverse().flatMap(imagesOf);
  const fromIt = newer.rows.flatMap(imagesOf);
  const at = fromIt.findIndex(
    (img) => img.imageAt === around && (key === undefined || img.attachment.key === key),
  );
  const earlier = at < 0 ? before : [...before, ...fromIt.slice(0, at)];
  const later = at < 0 ? fromIt : fromIt.slice(at + 1);
  const kept = {
    earlier: earlier.slice(-MEDIA_WINDOW),
    later: later.slice(0, MEDIA_WINDOW),
  };
  return {
    images: [...kept.earlier, ...(at < 0 ? [] : [fromIt[at]!]), ...kept.later],
    index: at < 0 ? -1 : kept.earlier.length,
    hasOlder: earlier.length > MEDIA_WINDOW || older.more,
    hasNewer: later.length > MEDIA_WINDOW || newer.more,
  };
}
