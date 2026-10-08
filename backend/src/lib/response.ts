import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { ErrorCode, ServerEvent } from "@mindfultech/shared";
import { requireEnv } from "./env";

export interface HandlerResult {
  statusCode: number;
  body?: string;
}

let client: ApiGatewayManagementApiClient | undefined;

export function managementApi(): ApiGatewayManagementApiClient {
  client ??= new ApiGatewayManagementApiClient({ endpoint: requireEnv("WS_ENDPOINT") });
  return client;
}

export const ok = (): HandlerResult => ({ statusCode: 200 });

/**
 * Sends `event` to one connection.
 * @returns `false` if the connection is gone (410), `true` otherwise.
 */
export async function reply(connectionId: string, event: ServerEvent): Promise<boolean> {
  try {
    await managementApi().send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(event) }),
    );
    return true;
  } catch (err) {
    if (err instanceof GoneException) return false;
    throw err;
  }
}

export async function replyError(
  connectionId: string,
  code: ErrorCode,
  message?: string,
  requestId?: string,
): Promise<HandlerResult> {
  await reply(connectionId, { type: "error", code, message, requestId });
  return { statusCode: code === "INTERNAL_ERROR" ? 500 : 400 };
}

export const badRequest = (connectionId: string, message?: string, requestId?: string) =>
  replyError(connectionId, "BAD_REQUEST", message, requestId);
