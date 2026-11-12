/**
 * One-off: deletes `users` rows whose Cognito account no longer exists
 * (accounts deleted straight from Cognito before the `user-cleanup` Lambda
 * existed). Those orphans kept showing in the DM list. Dry run by default;
 * safe to run again.
 *
 *   pnpm --filter infra cleanup-orphans dev             # dry run: lists the orphans
 *   pnpm --filter infra cleanup-orphans dev --apply     # deletes them
 *
 * The pool id comes from the stack's `UserPoolId` output (SlackDev / SlackProd).
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cleanupOrphans } from "./backfill/orphans";

const stage = process.argv[2];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: cleanup-orphans.ts <dev|prod> [--apply] [--force]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const region = process.env.AWS_REGION ?? "us-east-1";

const stackName = stage === "prod" ? "SlackProd" : "SlackDev";
const { Stacks } = await new CloudFormationClient({ region }).send(
  new DescribeStacksCommand({ StackName: stackName }),
);
const userPoolId = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "UserPoolId")?.OutputValue;
if (!userPoolId) {
  console.error(`${stackName} has no UserPoolId output: is it deployed?`);
  process.exit(1);
}

const table = `slack-${stage}-users`;
const report = await cleanupOrphans(
  DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
  new CognitoIdentityProviderClient({ region }),
  { table, userPoolId, apply, force },
);

console.log(
  `${report.profiles} profiles in ${table}, ${report.accounts} accounts in ${userPoolId}`,
);
for (const o of report.orphans) {
  console.log(`  orphan: ${o.userId}  ${o.email || "(no email)"}  ${o.displayName}`);
}
let summary = `${report.orphans.length} orphaned profile(s) to delete (dry run; add --apply).`;
if (report.orphans.length === 0) summary = "No orphaned profiles.";
else if (apply) summary = `Deleted ${report.deleted} orphaned profile(s).`;
console.log(summary);
