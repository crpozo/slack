import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import OpenAI from "openai";
import { errorFields, log } from "./logger";

/**
 * The OpenAI API key (Phase 43, Whisper). `OPENAI_API_KEY` from the
 * environment wins (local runs, tests); a deployed Lambda reads it instead
 * from the SecureString parameter named by `OPENAI_API_KEY_PARAMETER`
 * (`/slack/<stage>/openai-api-key`), so the key never appears in templates,
 * `cdk.out` or the function's configuration. Cached per container; `null`
 * while neither is set (transcription is then off).
 */
let ssm: SSMClient | undefined;
let cachedKey: Promise<string | null> | undefined;

async function loadKey(): Promise<string | null> {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const name = process.env.OPENAI_API_KEY_PARAMETER;
  if (!name) return null;
  ssm ??= new SSMClient({});
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return Parameter?.Value?.trim() || null;
  } catch (err) {
    // Not set up for this stage yet.
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

export function openaiApiKey(): Promise<string | null> {
  cachedKey ??= loadKey().catch((err: unknown) => {
    cachedKey = undefined; // retry on the next call
    log.warn("couldn't load the OpenAI API key", errorFields(err));
    return null;
  });
  return cachedKey;
}

/**
 * A client for one Whisper request inside API Gateway's 30 s: a single try of
 * up to 25 s (the app retries a clip that failed).
 */
export async function openaiClient(): Promise<OpenAI | null> {
  const apiKey = await openaiApiKey();
  return apiKey ? new OpenAI({ apiKey, timeout: 25_000, maxRetries: 0 }) : null;
}

/** Tests only. */
export function resetOpenAiKey(): void {
  cachedKey = undefined;
  ssm = undefined;
}
