import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

/** The part of the Messages client the workers use (a fake in tests). */
export interface ClaudeModel {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/**
 * Claude on Amazon Bedrock through the standard runtime (`InvokeModel`,
 * service `bedrock`), signed with the Lambda's role (SigV4, region from
 * `AWS_REGION`). Built once per container by each worker. `timeout` keeps one
 * request, retries included, under the worker's own timeout.
 *
 * Not the Mantle endpoint (`AnthropicBedrockMantle`, `bedrock-mantle`): Mantle
 * has its own per-account model lineup, and Claude Haiku 5.5 isn't served on
 * it for this account (`404 not_found_error` on 2026-10-22 and 2026-10-26),
 * while the standard runtime has it.
 */
export function bedrockModel(timeout = 50_000): ClaudeModel {
  const client = new AnthropicBedrock({ timeout, maxRetries: 1 });
  return { create: (params) => client.messages.create(params) };
}
