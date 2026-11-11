import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { errorFields, log } from "./logger";

let ssm: SSMClient | undefined;

/**
 * An optional secret: the environment variable `envName` when set (local
 * runs, tests), else the SecureString parameter named by `parameterEnv`
 * (deployed Lambdas; the value never sits in a template or the function's
 * configuration). `null` while neither is set. Cached per container for a few minutes
 * (`SECRET_TTL_MS`), so a parameter stored or replaced later is picked up
 * without a redeploy.
 */
const SECRET_TTL_MS = 5 * 60_000;

export function optionalSecret(envName: string, parameterEnv: string) {
  let cached: Promise<string | null> | undefined;
  let loadedAt = 0;
  async function load(): Promise<string | null> {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
    const name = process.env[parameterEnv];
    if (!name) return null;
    ssm ??= new SSMClient({});
    try {
      const { Parameter } = await ssm.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      return Parameter?.Value?.trim() || null;
    } catch (err) {
      if (err instanceof ParameterNotFound) return null;
      throw err;
    }
  }
  return {
    get(): Promise<string | null> {
      if (cached && Date.now() - loadedAt > SECRET_TTL_MS) cached = undefined;
      if (!cached) loadedAt = Date.now();
      cached ??= load().catch((err: unknown) => {
        cached = undefined; // retry on the next call
        log.warn(`couldn't load ${envName}`, errorFields(err));
        return null;
      });
      return cached;
    },
    /** Tests only. */
    reset(): void {
      cached = undefined;
      ssm = undefined;
    },
  };
}
