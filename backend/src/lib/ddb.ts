import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
}
