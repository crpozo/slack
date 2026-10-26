/**
 * Phase 38: indexes the files and links of messages sent before the
 * `channel-media` table existed, so a conversation's Files & Links tab shows
 * its whole history. Run once per stage after deploying Phase 38; safe to run
 * again (it rewrites identical rows).
 *
 *   pnpm --filter infra backfill-media prod            # dry run: counts, writes nothing
 *   pnpm --filter infra backfill-media prod --apply    # writes the rows
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillMedia } from "./backfill/media";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: backfill-media.ts <dev|prod> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const tables = {
  messages: `slack-${stage}-messages`,
  channelMedia: `slack-${stage}-channel-media`,
};

const report = await backfillMedia(ddb, tables, { apply });
console.log(
  `${report.messages} messages with files or links in ${tables.messages}: ` +
    `${report.files} files, ${report.links} links, ${report.pins} pins ` +
    (apply ? `written to ${tables.channelMedia}` : "to write (dry run; add --apply)"),
);
