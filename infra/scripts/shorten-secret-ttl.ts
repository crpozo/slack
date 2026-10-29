/**
 * Secrets now expire after 24 hours instead of a week. The app hides older
 * ones at once; this brings the stored TTL of secrets sent before the change
 * down to 24 hours after they were sent, so DynamoDB deletes their rows on the
 * new schedule. Run once per stage after deploying; safe to run again.
 *
 *   pnpm --filter infra shorten-secret-ttl prod            # dry run: counts, writes nothing
 *   pnpm --filter infra shorten-secret-ttl prod --apply    # shortens the TTLs
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { shortenSecretTtl } from "./backfill/secrets";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: shorten-secret-ttl.ts <dev|prod> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
);
const table = `slack-${stage}-messages`;

const report = await shortenSecretTtl(ddb, table, { apply });
console.log(
  `${report.secrets} secrets in ${table}: ${report.shortened} with a TTL past 24 hours ` +
    `(${report.overdue} of them already overdue) ` +
    (apply ? "shortened" : "to shorten (dry run; add --apply)"),
);
