import {
  BatchWriteCommand,
  paginateScan,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { mediaRows, pinRow, type IndexedMessage, type Message } from "@mindfultech/shared";

/** DynamoDB caps BatchWriteItem at 25 requests. */
const BATCH = 25;

export interface MediaBackfillReport {
  /** Messages read that have files or links (secrets and cards are skipped). */
  messages: number;
  files: number;
  links: number;
  /** Pins (none before Phase 38; counted in case of a re-run). */
  pins: number;
}

/**
 * DynamoDB string sets come back as `Set`s and numbers as numbers; anything
 * malformed is skipped rather than indexed wrong.
 */
function asMessage(
  item: Record<string, unknown>,
): (IndexedMessage & Pick<Message, "pinnedAt" | "pinnedBy">) | null {
  if (
    typeof item.channelId !== "string" ||
    typeof item.sk !== "string" ||
    typeof item.messageId !== "string" ||
    typeof item.userId !== "string" ||
    typeof item.createdAt !== "number"
  ) {
    return null;
  }
  return {
    channelId: item.channelId,
    sk: item.sk,
    messageId: item.messageId,
    userId: item.userId,
    createdAt: item.createdAt,
    text: typeof item.text === "string" ? item.text : "",
    attachments: Array.isArray(item.attachments)
      ? (item.attachments as Message["attachments"])
      : [],
    ...(typeof item.parentSk === "string" && { parentSk: item.parentSk }),
    ...(item.isSecret === true && { isSecret: true as const }),
    ...(typeof item.kind === "string" && { kind: item.kind as Message["kind"] }),
    ...(typeof item.deletedAt === "number" && { deletedAt: item.deletedAt }),
    ...(typeof item.pinnedAt === "number" && { pinnedAt: item.pinnedAt }),
    ...(typeof item.pinnedBy === "string" && { pinnedBy: item.pinnedBy }),
  };
}

/** The index rows one stored message should have: exactly what the app writes for it. */
export function rowsOf(item: Record<string, unknown>): Record<string, unknown>[] {
  const message = asMessage(item);
  if (!message) return [];
  return [
    ...mediaRows(message),
    ...(message.pinnedAt && !message.deletedAt
      ? [pinRow(message, message.pinnedAt, message.pinnedBy ?? "")]
      : []),
  ] as unknown as Record<string, unknown>[];
}

/**
 * Phase 38: indexes the files and links of every message sent before the
 * `channel-media` table existed (from Phase 38 on, sending, editing and
 * deleting keep it current). One scan of `messages`, filtered server-side to
 * messages with files or "http" in their text, then batched puts. Idempotent:
 * a row is the same item every time, so running it again rewrites identical
 * rows.
 */
export async function backfillMedia(
  ddb: DynamoDBDocumentClient,
  tables: { messages: string; channelMedia: string },
  { apply }: { apply: boolean },
): Promise<MediaBackfillReport> {
  const report: MediaBackfillReport = { messages: 0, files: 0, links: 0, pins: 0 };
  let pending: Record<string, unknown>[] = [];

  const flush = async (rows: Record<string, unknown>[]) => {
    let requests: Record<string, unknown>[] = rows.map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt === 5) throw new Error(`${requests.length} rows left unwritten (throttled)`);
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      const { UnprocessedItems } = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tables.channelMedia]: requests } }),
      );
      requests = (UnprocessedItems?.[tables.channelMedia] ?? []) as Record<string, unknown>[];
    }
  };

  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: tables.messages,
      // Only what can have rows; the code below decides exactly which.
      FilterExpression:
        "size(attachments) > :zero OR contains(#text, :http) OR attribute_exists(pinnedAt)",
      ExpressionAttributeNames: { "#text": "text" },
      ExpressionAttributeValues: { ":zero": 0, ":http": "http" },
    },
  )) {
    for (const item of page.Items ?? []) {
      const rows = rowsOf(item);
      if (rows.length === 0) continue;
      report.messages++;
      for (const row of rows) {
        if (row.kind === "file") report.files++;
        else if (row.kind === "link") report.links++;
        else report.pins++;
      }
      if (!apply) continue;
      pending.push(...rows);
      while (pending.length >= BATCH) {
        await flush(pending.slice(0, BATCH));
        pending = pending.slice(BATCH);
      }
    }
  }
  if (apply && pending.length > 0) await flush(pending);
  return report;
}
