/**
 * Phase 29: adds the AI Notes hub's pointers for notes cards posted before
 * the hub existed (from Phase 28 on, `POST /calls/summary` writes them).
 * Run once per stage after deploying Phase 29; safe to run again.
 *
 *   pnpm --filter infra backfill-notes prod            # dry run: counts, writes nothing
 *   pnpm --filter infra backfill-notes prod --apply    # writes the pointers
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillNotes } from "./backfill/notes";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: backfill-notes.ts <dev|prod> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
);
const tables = {
  messages: `slack-${stage}-messages`,
  meetingNotes: `slack-${stage}-meeting-notes`,
};

const report = await backfillNotes(ddb, tables, { apply });
console.log(
  `${report.cards} AI notes cards in ${tables.messages}: ${report.pointers} pointers ${
    apply ? `written to ${tables.meetingNotes}` : "to write (dry run; add --apply)"
  }`,
);
