import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ServerEvent } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { vi } from "vitest";
import type { WsEvent } from "../src/lib/handler";

export const ddbMock = mockClient(DynamoDBDocumentClient);
export const apiMock = mockClient(ApiGatewayManagementApiClient);

export const ALICE = { userId: "user-alice", email: "alice@example.com" };
export const BOB = { userId: "user-bob", email: "bob@example.com" };

export function resetMocks(): void {
  ddbMock.reset();
  apiMock.reset();
  apiMock.on(PostToConnectionCommand).resolves({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

export function wsEvent(
  routeKey: string,
  body?: unknown,
  opts: { connectionId?: string; user?: { userId: string; email: string } | null } = {},
): WsEvent {
  const user = opts.user === undefined ? ALICE : opts.user;
  return {
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      routeKey,
      connectionId: opts.connectionId ?? "conn-alice",
      authorizer: user ? { userId: user.userId, email: user.email } : undefined,
    },
  } as unknown as WsEvent;
}

/** Events sent with PostToConnection, as `[connectionId, event]` pairs. */
export function sentEvents(): Array<[string, ServerEvent]> {
  return apiMock.commandCalls(PostToConnectionCommand).map((call) => {
    const { ConnectionId, Data } = call.args[0].input;
    return [ConnectionId as string, JSON.parse(String(Data)) as ServerEvent];
  });
}
