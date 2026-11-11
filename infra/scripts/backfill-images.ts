/**
 * Phase 61: puts the images sent before the gallery's sparse index existed
 * into it (gives their messages `imageAt`), so the viewer's arrows reach the
 * whole history. Run once per stage after deploying Phase 61; safe to run
 * again (it only touches messages that don't have `imageAt` yet).
 *
 *   pnpm --filter infra backfill-images prod            # dry run: counts, writes nothing
 *   pnpm --filter infra backfill-images prod --apply    # writes `imageAt`
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillImages } from "./backfill/images";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: backfill-images.ts <dev|prod> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const table = `slack-${stage}-messages`;

const report = await backfillImages(ddb, table, { apply });
console.log(
  `${report.scanned} messages with attachments not yet in the gallery in ${table}: ` +
    `${report.images} with images ` +
    (apply
      ? `indexed, ${report.skipped} deleted meanwhile (skipped)`
      : "to index (dry run; add --apply)"),
);
