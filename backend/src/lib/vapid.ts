import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { requireEnv } from "./env";
import { errorFields, log } from "./logger";

/**
 * VAPID keys live in ONE SecureString parameter, `/slack/<stage>/vapid`, as
 * `{ publicKey, privateKey, subject }`, written once by
 * `pnpm --filter infra vapid <stage>`. CloudFormation only knows the parameter's
 * name, so the private key never appears in templates, `cdk.out`, logs or
 * Lambda environment variables; it is decrypted here at cold start and cached.
 */
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact the push services can reach. */
  subject: string;
}

let ssm: SSMClient | undefined;
let cached: Promise<VapidConfig | null> | undefined;

function isVapidConfig(value: unknown): value is VapidConfig {
  const v = value as Partial<VapidConfig> | null;
  return (
    typeof v?.publicKey === "string" &&
    typeof v.privateKey === "string" &&
    typeof v.subject === "string" &&
    /^(mailto:|https:)/.test(v.subject)
  );
}

async function load(): Promise<VapidConfig | null> {
  ssm ??= new SSMClient({});
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: requireEnv("VAPID_PARAMETER"), WithDecryption: true }),
    );
    const parsed: unknown = JSON.parse(Parameter?.Value ?? "null");
    if (isVapidConfig(parsed)) return parsed;
    log.error("VAPID parameter is malformed");
    return null;
  } catch (err) {
    // Not set up for this stage yet: push is simply off.
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

/** The stage's VAPID keys, or `null` when push isn't configured. Cached per container. */
export function vapidConfig(): Promise<VapidConfig | null> {
  cached ??= load().catch((err: unknown) => {
    cached = undefined; // retry on the next call
    log.warn("couldn't load VAPID keys", errorFields(err));
    return null;
  });
  return cached;
}

/** Tests only. */
export function resetVapidCache(): void {
  cached = undefined;
  ssm = undefined;
}
