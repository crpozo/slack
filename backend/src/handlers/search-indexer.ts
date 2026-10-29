import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { errorFields, log } from "../lib/logger";
import { applyIndexChanges, indexChange, isMessageRow, type IndexChange } from "../lib/search";

type StreamImage = Parameters<typeof unmarshall>[0];

const rowOf = (image: unknown) =>
  image ? (unmarshall(image as StreamImage) as Record<string, unknown>) : undefined;

/**
 * Keeps the message search index (Phase 42) in step with the messages table,
 * from its stream (old and new images): whatever wrote a message (sent,
 * edited, a card rewritten, deleted, a tombstone, a secret's TTL), the terms
 * it gained are written and the ones it lost deleted. A failed batch throws,
 * so the stream retries it (rewriting the same rows is harmless).
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const changes: IndexChange[] = [];
  for (const record of event.Records) {
    const before = rowOf(record.dynamodb?.OldImage);
    const after = rowOf(record.dynamodb?.NewImage);
    const change = indexChange(
      isMessageRow(before) ? before : undefined,
      isMessageRow(after) ? after : undefined,
    );
    if (change) changes.push(change);
  }
  if (changes.length === 0) return;
  try {
    await applyIndexChanges(changes);
  } catch (err) {
    log.error("search index write failed", { changes: changes.length, ...errorFields(err) });
    throw err;
  }
  log.info("search index updated", {
    records: event.Records.length,
    added: changes.reduce((n, c) => n + c.add.length, 0),
    removed: changes.reduce((n, c) => n + c.remove.length, 0),
  });
};
