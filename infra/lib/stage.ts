import { RemovalPolicy } from "aws-cdk-lib";

export type Stage = "dev" | "prod";

/** Dev resources are disposable; prod resources survive a stack deletion. */
export function removalPolicyFor(stage: Stage): RemovalPolicy {
  return stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/**
 * SecureString with this stage's Web Push VAPID keys, created by
 * `pnpm --filter infra vapid <stage>` (CloudFormation can't create SecureStrings,
 * and keeping it out of the stack keeps the keys out of every template).
 */
export const vapidParameterName = (stage: Stage) => `/slack/${stage}/vapid`;

/**
 * Phase 43: SecureString with this stage's OpenAI API key (Whisper), put there
 * by hand once (see the README); only the `call-transcribe` Lambda reads it.
 */
export const openaiKeyParameterName = (stage: Stage) => `/slack/${stage}/openai-api-key`;

/**
 * Phase 44, optional: a GitHub token (any fine-grained token with no extra
 * permissions) that lifts the AI Skills importer's API limit from 60 to 5,000
 * requests an hour. Only the `skills` Lambda reads it.
 */
/**
 * Phase 61, optional: an ElevenLabs API key (SecureString) for the AI News
 * audio, and the id of the voice to use (a plain String; a stock voice when
 * absent). Without the key the summary is read by Amazon Polly, as before.
 * Only the news worker reads them.
 */
export const elevenLabsKeyParameterName = (stage: Stage) => `/slack/${stage}/elevenlabs-api-key`;
export const elevenLabsVoiceParameterName = (stage: Stage) => `/slack/${stage}/elevenlabs-voice-id`;

export const githubTokenParameterName = (stage: Stage) => `/slack/${stage}/github-token`;
