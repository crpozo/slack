import {
  BatchWriteCommand,
  paginateScan,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { messageSearchTerms, searchIndexSk, type Message } from "@mindfultech/shared";

/** DynamoDB caps BatchWriteItem at 25 requests. */
const BATCH = 25;

export interface SearchBackfillReport {
  /** Messages read that have something searchable (secrets and deleted ones don't). */
  messages: number;
  /** Index rows: one per term of each message. */
  rows: number;
}

/**
 * The index rows one stored message should have: exactly what the stream
 * processor writes for it (none for a secret, a deleted message or anything
 * that isn't a message).
 */
export function searchRowsOf(
  item: Record<string, unknown>,
): Array<{ channelId: string; sk: string }> {
  if (typeof item.channelId !== "string" || typeof item.sk !== "string" || !("messageId" in item)) {
    return [];
  }
  const { channelId, sk } = item;
  return messageSearchTerms(item as unknown as Message).map((term) => ({
    channelId,
    sk: searchIndexSk(term, sk),
  }));
}

/**
 * Phase 42: indexes every message sent before the search index existed (from
 * the deploy on, the stream processor keeps it current, so run this after
 * deploying). One scan of `messages`, then batched puts. Idempotent: a row is
 * the same item every time, so running it again rewrites identical rows.
 */
export async function backfillSearch(
  ddb: DynamoDBDocumentClient,
  tables: { messages: string; messageSearch: string },
  { apply }: { apply: boolean },
): Promise<SearchBackfillReport> {
  const report: SearchBackfillReport = { messages: 0, rows: 0 };
  let pending: Record<string, unknown>[] = [];

  const flush = async (rows: Record<string, unknown>[]) => {
    let requests: Record<string, unknown>[] = rows.map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt === 5) throw new Error(`${requests.length} rows left unwritten (throttled)`);
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      const { UnprocessedItems } = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tables.messageSearch]: requests } }),
      );
      requests = (UnprocessedItems?.[tables.messageSearch] ?? []) as Record<string, unknown>[];
    }
  };

  for await (const page of paginateScan({ client: ddb }, { TableName: tables.messages })) {
    for (const item of page.Items ?? []) {
      const rows = searchRowsOf(item);
      if (rows.length === 0) continue;
      report.messages++;
      report.rows += rows.length;
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
