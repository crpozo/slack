/**
 * Moves everything the team has written in SlackDev to SlackProd:
 * accounts, channels, DMs, messages, reactions, boards, tasks and attachments.
 *
 *   pnpm --filter infra migrate-dev-to-prod            # dry run: reads, reports, writes nothing
 *   pnpm --filter infra migrate-dev-to-prod --apply    # does it
 *
 * Each person without an account in prod is asked for a password (it can be
 * the same as before: Cognito can't export passwords). SlackDev is only read,
 * never changed. Running it again later only brings over what's new.
 */
import { createInterface } from "node:readline";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { migrate } from "./migrate/run";

const MIN_PASSWORD_LENGTH = 8;
const region = process.env.AWS_REGION ?? "us-east-1";
const apply = process.argv.includes("--apply");

/** Reads a line without echoing it (the password). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WriteStream;
    };
    let prompted = false;
    output._writeToOutput = (s: string) => {
      if (!prompted) {
        output.output.write(s);
        prompted = true;
      } else if (s.includes("\n") || s.includes("\r")) {
        output.output.write("\n");
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function passwordFor(email: string): Promise<string> {
  for (;;) {
    const password = await askHidden(`New password for ${email} (min. ${MIN_PASSWORD_LENGTH}): `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.log(`  Too short, use at least ${MIN_PASSWORD_LENGTH} characters.`);
      continue;
    }
    if ((await askHidden("Repeat it: ")) === password) return password;
    console.log("  They don't match, try again.");
  }
}

const report = await migrate(
  {
    cfn: new CloudFormationClient({ region }),
    cognito: new CognitoIdentityProviderClient({ region }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({ region }),
  },
  {
    from: { stack: "SlackDev", stage: "dev" },
    to: { stack: "SlackProd", stage: "prod" },
    apply,
    passwordFor,
    log: (line) => console.log(line),
  },
);

const webUsers = report.users
  .filter((u) => !u.newId.startsWith("pending-"))
  .map((u) => `${u.email}=${u.newId}`)
  .join(",");
console.log("");
if (apply) {
  console.log("Done. Sign in at the prod URL with the new passwords.");
  if (webUsers) console.log(`If you use WEB_USERS, set it to: ${webUsers}`);
} else {
  console.log("Nothing was written. Run again with --apply to migrate.");
}
