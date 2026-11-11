import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { paginateScan, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { IMAGE_AT_ATTRIBUTE, imageAtOf, type Message } from "@mindfultech/shared";

export interface ImagesBackfillReport {
  /** Messages read with attachments and no `imageAt` yet. */
  scanned: number;
  /** Of those, the ones with an image (given `imageAt`, or to be in a dry run). */
  images: number;
  /** Deleted or changed between the scan and the write: left alone. */
  skipped: number;
}

/** `imageAt` for a stored row, or `undefined` (malformed rows are left out). */
export function imageAtOfRow(item: Record<string, unknown>): string | undefined {
  if (
    typeof item.channelId !== "string" ||
    typeof item.sk !== "string" ||
    typeof item.messageId !== "string" ||
    typeof item.createdAt !== "number" ||
    !Array.isArray(item.attachments)
  ) {
    return undefined;
  }
  const attachments = (item.attachments as Array<Record<string, unknown>>).filter(
    (a) => a && typeof a.contentType === "string",
  ) as unknown as Message["attachments"];
  return imageAtOf({
    createdAt: item.createdAt,
    messageId: item.messageId,
    attachments,
    ...(item.isSecret === true && { isSecret: true as const }),
    ...(typeof item.kind === "string" && { kind: item.kind as Message["kind"] }),
    ...(typeof item.deletedAt === "number" && { deletedAt: item.deletedAt }),
  });
}

/**
 * Phase 61: gives `imageAt` to the messages with images sent before the
 * gallery's sparse index existed (from Phase 61 on, sending writes it and
 * deleting removes it), so the viewer reaches back through the whole
 * history. One scan of `messages` filtered to rows with attachments and no
 * `imageAt` yet, then one conditional UpdateItem per image message: a row
 * deleted or emptied since the scan is skipped, never re-indexed.
 * Idempotent: a second run finds nothing left to do.
 */
export async function backfillImages(
  ddb: DynamoDBDocumentClient,
  table: string,
  { apply }: { apply: boolean },
): Promise<ImagesBackfillReport> {
  const report: ImagesBackfillReport = { scanned: 0, images: 0, skipped: 0 };
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: table,
      FilterExpression: "size(#attachments) > :zero AND attribute_not_exists(#imageAt)",
      ProjectionExpression:
        "#channelId, #sk, #messageId, #createdAt, #attachments, #isSecret, #kind, #deletedAt",
      ExpressionAttributeNames: {
        "#channelId": "channelId",
        "#sk": "sk",
        "#messageId": "messageId",
        "#createdAt": "createdAt",
        "#attachments": "attachments",
        "#isSecret": "isSecret",
        "#kind": "kind",
        "#deletedAt": "deletedAt",
        "#imageAt": IMAGE_AT_ATTRIBUTE,
      },
      ExpressionAttributeValues: { ":zero": 0 },
    },
  )) {
    for (const item of page.Items ?? []) {
      report.scanned++;
      const imageAt = imageAtOfRow(item);
      if (!imageAt) continue;
      report.images++;
      if (!apply) continue;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { channelId: item.channelId, sk: item.sk },
            UpdateExpression: "SET #imageAt = :at",
            // Still there, still the same message, still not deleted.
            ConditionExpression:
              "attribute_exists(#sk) AND #messageId = :id AND attribute_not_exists(#deletedAt)",
            ExpressionAttributeNames: {
              "#imageAt": IMAGE_AT_ATTRIBUTE,
              "#sk": "sk",
              "#messageId": "messageId",
              "#deletedAt": "deletedAt",
            },
            ExpressionAttributeValues: { ":at": imageAt, ":id": item.messageId },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        report.images--;
        report.skipped++;
      }
    }
  }
  return report;
}
