/**
 * Creates #general (`ch_general`) if it does not exist yet. Idempotent.
 * Usage: pnpm --filter infra seed <dev|prod>
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GENERAL_CHANNEL_ID, type Channel } from "@mindfultech/shared";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: seed-general.ts <dev|prod>");
  process.exit(1);
}

const tableName = `slack-${stage}-channels`;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const general: Channel = {
  channelId: GENERAL_CHANNEL_ID,
  name: "general",
  type: "public",
  createdBy: "system",
  createdAt: Date.now(),
  archived: false,
};

try {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: general,
      ConditionExpression: "attribute_not_exists(channelId)",
    }),
  );
  console.log(`Seeded ${GENERAL_CHANNEL_ID} in ${tableName}`);
} catch (err) {
  if (err instanceof ConditionalCheckFailedException) {
    console.log(`${GENERAL_CHANNEL_ID} already exists in ${tableName}`);
  } else {
    throw err;
  }
}
