import { BatchGetCommand, BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  isThreadSk,
  matchesAllTerms,
  messageSearchTerms,
  messageSkOfIndexSk,
  SEARCH_MAX_RESULTS,
  searchableText,
  searchIndexSk,
  searchSnippet,
  searchTerms,
  sortKeyTime,
  type Channel,
  type Message,
  type SearchResponse,
  type SearchResult,
} from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Message search (Phase 42): keeping the inverted index and reading it. See
// @mindfultech/shared search.ts for the shape of the index.
// ---------------------------------------------------------------------------

/** Index rows read per conversation and search: enough for the newest matches. */
export const SEARCH_ROWS_PER_CHANNEL = 200;
/** Matching messages read (one BatchGet) before checking every query term. */
export const SEARCH_CANDIDATES = 100;
/** Conversations queried at once. */
const QUERY_CONCURRENCY = 8;

/** What changed in a message's terms: rows to write and rows to delete. */
export interface IndexChange {
  channelId: string;
  sk: string;
  add: string[];
  remove: string[];
}

type Indexable = Parameters<typeof messageSearchTerms>[0] & Pick<Message, "channelId" | "sk">;

/** A stored row that's a message (the table holds nothing else today, but be sure). */
export const isMessageRow = (row: Record<string, unknown> | undefined): row is Indexable =>
  !!row && typeof row.channelId === "string" && typeof row.sk === "string" && "messageId" in row;

/**
 * The index rows a message's change needs: the terms it gained and lost.
 * `before`/`after` are the stored rows (either missing: created / removed).
 */
export function indexChange(before?: Indexable, after?: Indexable): IndexChange | null {
  const row = after ?? before;
  if (!row) return null;
  const old = new Set(before ? messageSearchTerms(before) : []);
  const now = new Set(after ? messageSearchTerms(after) : []);
  const add = [...now].filter((t) => !old.has(t));
  const remove = [...old].filter((t) => !now.has(t));
  if (add.length === 0 && remove.length === 0) return null;
  return { channelId: row.channelId, sk: row.sk, add, remove };
}

type WriteRequest = NonNullable<
  NonNullable<ConstructorParameters<typeof BatchWriteCommand>[0]["RequestItems"]>[string]
>[number];

/** Writes and deletes index rows, 25 at a time, retrying what DynamoDB sends back. */
export async function applyIndexChanges(changes: IndexChange[]): Promise<void> {
  const requests: WriteRequest[] = [];
  for (const { channelId, sk, add, remove } of changes) {
    for (const term of add) {
      requests.push({
        PutRequest: { Item: { channelId, sk: searchIndexSk(term, sk) } },
      });
    }
    for (const term of remove) {
      requests.push({ DeleteRequest: { Key: { channelId, sk: searchIndexSk(term, sk) } } });
    }
  }
  for (let i = 0; i < requests.length; i += 25) {
    let pending: WriteRequest[] = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** attempt)));
      if (attempt === 8) throw new Error(`index write throttled (${pending.length} rows left)`);
      const { UnprocessedItems } = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tables.messageSearch]: pending } }),
      );
      pending = (UnprocessedItems?.[tables.messageSearch] ?? []) as WriteRequest[];
    }
  }
}

/** Runs `fn` over `items`, `limit` at a time. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

/**
 * Searches the messages of `channels` (the ones the caller can see) for
 * `query`: every term must start a word of the message ("logi" finds
 * "login"). One `begins_with` query per conversation on the index, for the
 * query's longest term (the most selective); the newest candidates are read
 * in one BatchGet and checked for all the terms. Newest first.
 */
export async function searchMessages(query: string, channels: Channel[]): Promise<SearchResponse> {
  const terms = searchTerms(query);
  if (terms.length === 0 || channels.length === 0) return { results: [], terms, truncated: false };
  const probe = [...terms].sort((a, b) => b.length - a.length)[0]!;

  let truncated = false;
  const perChannel = await mapLimited(channels, QUERY_CONCURRENCY, async (channel) => {
    const { Items, LastEvaluatedKey } = await ddb.send(
      new QueryCommand({
        TableName: tables.messageSearch,
        KeyConditionExpression: "channelId = :c AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":c": channel.channelId, ":p": probe },
        ProjectionExpression: "sk",
        ScanIndexForward: false,
        Limit: SEARCH_ROWS_PER_CHANNEL,
      }),
    );
    if (LastEvaluatedKey) truncated = true;
    return (Items ?? []).map((item) => ({
      channelId: channel.channelId,
      sk: messageSkOfIndexSk(String(item.sk)),
    }));
  });

  // One message can match through several terms ("login", "logins"): once each, newest first.
  const seen = new Set<string>();
  const candidates = perChannel
    .flat()
    .filter((c) => {
      const key = `${c.channelId}\n${c.sk}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => sortKeyTime(b.sk) - sortKeyTime(a.sk));
  if (candidates.length > SEARCH_CANDIDATES) truncated = true;

  const messages = await batchGetMessages(candidates.slice(0, SEARCH_CANDIDATES));
  const results: SearchResult[] = [];
  for (const { channelId, sk } of candidates.slice(0, SEARCH_CANDIDATES)) {
    const message = messages.get(`${channelId}\n${sk}`);
    if (!message) continue; // deleted since (the index catches up in a moment)
    const text = searchableText(message);
    if (!text || !matchesAllTerms(text, terms)) continue;
    results.push({
      channelId,
      messageId: message.messageId,
      sk,
      ...(message.parentSk && isThreadSk(sk) && { parentSk: message.parentSk }),
      userId: message.userId,
      createdAt: message.createdAt,
      snippet: searchSnippet(text, terms),
    });
    if (results.length === SEARCH_MAX_RESULTS) break;
  }
  return { results, terms, truncated };
}

/** The messages at `keys` (up to 100), by `channelId\nsk`; what's gone is simply missing. */
async function batchGetMessages(keys: Array<{ channelId: string; sk: string }>) {
  const found = new Map<string, Message>();
  let pending: Array<Record<string, unknown>> = keys;
  for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    const { Responses, UnprocessedKeys } = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [tables.messages]: {
            Keys: pending,
            ProjectionExpression:
              "channelId, sk, messageId, userId, createdAt, #text, attachments, isSecret, deletedAt, meeting, aiNotes, parentSk, expiresAt",
            ExpressionAttributeNames: { "#text": "text" },
          },
        },
      }),
    );
    for (const item of Responses?.[tables.messages] ?? []) {
      const message = item as Message;
      found.set(`${message.channelId}\n${message.sk}`, message);
    }
    pending = (UnprocessedKeys?.[tables.messages]?.Keys ?? []) as Array<Record<string, unknown>>;
  }
  if (pending.length > 0) log.warn("search read throttled", { left: pending.length });
  return found;
}
