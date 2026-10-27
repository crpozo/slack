import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

/** The part of the Messages client the workers use (a fake in tests). */
export interface ClaudeModel {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/**
 * Claude in Amazon Bedrock, signed with the Lambda's role (SigV4, service
 * `bedrock-mantle`, region from `AWS_REGION`). Built once per container by
 * each worker. `timeout` keeps one request, retries included, under the
 * worker's own timeout.
 */
export function bedrockModel(timeout = 50_000): ClaudeModel {
  const client = new AnthropicBedrockMantle({ timeout, maxRetries: 1 });
  return { create: (params) => client.messages.create(params) };
}
