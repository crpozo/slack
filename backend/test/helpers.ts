import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId, type Channel, type ServerEvent } from "@mindfultech/shared";
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

export const GENERAL: Channel = {
  channelId: "ch_general",
  name: "general",
  type: "public",
  createdBy: "system",
  createdAt: 1,
  archived: false,
};

export function dmRow(a: string, b: string): Channel {
  const channelId = dmChannelId(a, b);
  return {
    channelId,
    name: channelId,
    type: "dm",
    createdBy: a,
    createdAt: 2,
    archived: false,
    members: [a, b].sort(),
  };
}

export function privateRow(channelId: string, createdBy: string, members: string[]): Channel {
  return {
    channelId,
    name: channelId.replace(/^ch_/, ""),
    type: "private",
    createdBy,
    createdAt: 3,
    archived: false,
    members,
  };
}

/** Channel GetItem lookups resolve to these rows by key; anything else is "not found". */
export function mockChannels(...rows: Channel[]): void {
  ddbMock.on(GetCommand, { TableName: "slack-test-channels" }).resolves({});
  for (const row of rows) {
    ddbMock
      .on(GetCommand, { TableName: "slack-test-channels", Key: { channelId: row.channelId } })
      .resolves({ Item: row });
  }
}
