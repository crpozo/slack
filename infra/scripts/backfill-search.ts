/**
 * Phase 42: indexes the messages sent before the `message-search` table
 * existed, so a search finds the whole history. Run once per stage after
 * deploying Phase 42 (the stream keeps it current from the deploy on); safe
 * to run again (it rewrites identical rows).
 *
 *   pnpm --filter infra backfill-search prod            # dry run: counts, writes nothing
 *   pnpm --filter infra backfill-search prod --apply    # writes the rows
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillSearch } from "./backfill/search";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: backfill-search.ts <dev|prod> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const tables = {
  messages: `slack-${stage}-messages`,
  messageSearch: `slack-${stage}-message-search`,
};

const report = await backfillSearch(ddb, tables, { apply });
console.log(
  `${report.messages} searchable messages in ${tables.messages}: ${report.rows} index rows ` +
    (apply ? `written to ${tables.messageSearch}` : "to write (dry run; add --apply)"),
);
