import type { Role } from "@mindfultech/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { requireEnv } from "./env";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Table names, read lazily so tests can set the environment first. */
export const tables = {
  get messages() {
    return requireEnv("MESSAGES_TABLE");
  },
  get connections() {
    return requireEnv("CONNECTIONS_TABLE");
  },
  get channels() {
    return requireEnv("CHANNELS_TABLE");
  },
  get users() {
    return requireEnv("USERS_TABLE");
  },
  get boards() {
    return requireEnv("BOARDS_TABLE");
  },
  get tasks() {
    return requireEnv("TASKS_TABLE");
  },
  get pushSubscriptions() {
    return requireEnv("PUSH_SUBSCRIPTIONS_TABLE");
  },
  get events() {
    return requireEnv("EVENTS_TABLE");
  },
  get vacationBalances() {
    return requireEnv("VACATION_BALANCES_TABLE");
  },
};

/** Row of the `connections` table. */
export interface ConnectionItem {
  connectionId: string;
  userId: string;
  userEmail: string;
  /** Epoch milliseconds. */
  connectedAt: number;
  /** Epoch seconds (DynamoDB TTL). */
  ttl: number;
  /** Epoch milliseconds of the last `ping` with `active: true` (absent while in the background). */
  activeAt?: number;
  /** From the token's Cognito groups; absent on rows from before roles (members). */
  role?: Role;
}

/** DynamoDB caps BatchWriteItem at 25 requests. */
const BATCH_SIZE = 25;

type WriteRequest = Record<string, unknown>;

/** One BatchWriteItem, re-sending what DynamoDB left unprocessed (throttling) up to `retries` times. */
async function writeBatch(table: string, requests: WriteRequest[], retries = 2): Promise<void> {
  const { UnprocessedItems } = await ddb.send(
    new BatchWriteCommand({ RequestItems: { [table]: requests } }),
  );
  const left = (UnprocessedItems?.[table] ?? []) as WriteRequest[];
  if (left.length === 0) return;
  if (retries <= 0) throw new Error(`Couldn't delete ${left.length} items from ${table}`);
  return writeBatch(table, left, retries - 1);
}

/** Deletes `keys` from `table` in concurrent batches of 25; throws if any item is left. */
export async function batchDelete(table: string, keys: Record<string, unknown>[]): Promise<void> {
  const batches: WriteRequest[][] = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    batches.push(keys.slice(i, i + BATCH_SIZE).map((Key) => ({ DeleteRequest: { Key } })));
  }
  await Promise.all(batches.map((batch) => writeBatch(table, batch)));
}
