/**
 * Creates #general (`ch_general`) on a fresh install: only while the channels
 * table holds no channel at all. Since Phase 54 an admin may delete #general,
 * and every deploy runs this script, so on a workspace that has channels it
 * leaves things as they are (it would otherwise bring a deleted #general back,
 * empty). Idempotent.
 * Usage: pnpm --filter infra seed <dev|prod>
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
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

/** Whether any channel (not a DM) exists: then this isn't a fresh install. */
async function hasChannels(): Promise<boolean> {
  for await (const page of paginateScan(
    { client },
    {
      TableName: tableName,
      ProjectionExpression: "channelId, #type",
      ExpressionAttributeNames: { "#type": "type" },
    },
  )) {
    if ((page.Items ?? []).some((item) => item.type !== "dm")) return true;
  }
  return false;
}

if (await hasChannels()) {
  console.log(`${tableName} already has channels: #general is left as it is (kept, or deleted)`);
  process.exit(0);
}

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
