/**
 * One-time Web Push setup per stage: generates a VAPID key pair and stores it,
 * with the contact `subject`, as ONE SecureString parameter `/slack/<stage>/vapid`
 * (Parameter Store standard tier: free; encrypted with the AWS-managed aws/ssm key).
 * CloudFormation never sees the keys: the Lambdas read the parameter at runtime.
 *
 *   pnpm --filter infra vapid <dev|prod> [--subject mailto:ops@example.com] [--rotate]
 *
 * Refuses to overwrite existing keys unless `--rotate` is passed: rotating
 * invalidates every browser subscription (clients re-subscribe on their next
 * visit, because the public key they read from GET /push/key changed).
 */
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import webpush from "web-push";

const args = process.argv.slice(2);
const stage = args[0];
if (stage !== "dev" && stage !== "prod") {
  console.error("Usage: vapid.ts <dev|prod> [--subject mailto:you@example.com] [--rotate]");
  process.exit(1);
}
const rotate = args.includes("--rotate");
const subjectIndex = args.indexOf("--subject");
const subject = subjectIndex >= 0 ? args[subjectIndex + 1] : "https://slack.mindfultech.ec";
if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("--subject must be a mailto: or https:// URL push services can contact");
  process.exit(1);
}

const name = `/slack/${stage}/vapid`;
const ssm = new SSMClient({ region: process.env.AWS_REGION ?? "us-east-1" });

async function exists(): Promise<boolean> {
  try {
    await ssm.send(new GetParameterCommand({ Name: name }));
    return true;
  } catch (err) {
    if (err instanceof ParameterNotFound) return false;
    throw err;
  }
}

if ((await exists()) && !rotate) {
  console.log(`${name} already exists; nothing to do (pass --rotate to replace the keys).`);
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
await ssm.send(
  new PutParameterCommand({
    Name: name,
    Type: "SecureString",
    Tier: "Standard",
    Overwrite: rotate,
    Description:
      "Web Push VAPID keys {publicKey, privateKey, subject} (see infra/scripts/vapid.ts)",
    Value: JSON.stringify({ publicKey, privateKey, subject }),
  }),
);
// Only the public half is printed; the private key exists nowhere but in the parameter.
console.log(`${rotate ? "Rotated" : "Created"} ${name}`);
console.log(`Public key: ${publicKey}`);
