import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId, GENERAL_CHANNEL_ID } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/call-notes";
import type { HttpEvent } from "../src/lib/http";
import {
  ALICE,
  BOB,
  ddbMock,
  dmRow,
  GENERAL,
  mockChannels,
  resetMocks,
  sentEvents,
} from "./helpers";

const lambdaMock = mockClient(LambdaClient);
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const DM = dmChannelId(ALICE.userId, BOB.userId);
const NOW = 1_760_000_000_000;
const MESSAGES = "slack-test-messages";

function request(body: unknown, user = ALICE): HttpEvent {
  return {
    version: "2.0",
    routeKey: "POST /calls/summary",
    rawPath: "/calls/summary",
    rawQueryString: "",
    headers: {},
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method: "POST", path: "/calls/summary" },
      authorizer: { jwt: { claims: { sub: user.userId, email: user.email }, scopes: [] } },
    },
  } as unknown as HttpEvent;
}
const call = async (body: unknown, user = ALICE) => {
  const result = (await handler(request(body, user))) as { statusCode: number; body: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};

const summary = (patch: Record<string, unknown> = {}) => ({
  callId: "01CALLCALLCALLCALLCALLCALL",
  channelId: DM,
  startedAt: NOW - 600_000,
  endedAt: NOW,
  segments: [
    { userId: ALICE.userId, text: "Can you review the contract?", at: NOW - 590_000 },
    { userId: BOB.userId, text: "Yes, tomorrow morning.", at: NOW - 585_000 },
  ],
  ...patch,
});

describe("POST /calls/summary", () => {
  beforeEach(() => {
    resetMocks();
    lambdaMock.reset();
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    mockChannels(GENERAL, dmRow(ALICE.userId, BOB.userId));
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
        { connectionId: "conn-carol", userId: CAROL.userId },
      ],
    });
  });

  it("posts a pending card at once, tells both people and starts the worker: 202", async () => {
    const { status, body } = await call(summary());
    expect(status).toBe(202);
    expect(body.message).toMatchObject({
      channelId: DM,
      userId: ALICE.userId,
      kind: "ai_notes",
      text: "✨ AI call notes: generating…",
      clientId: "ai-notes:01CALLCALLCALLCALLCALLCALL",
      aiNotes: {
        callId: "01CALLCALLCALLCALLCALLCALL",
        status: "pending",
        summary: "",
        startedAt: NOW - 600_000,
        endedAt: NOW,
        participants: [ALICE.userId, BOB.userId],
      },
    });
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put).toMatchObject({
      TableName: MESSAGES,
      ConditionExpression: "attribute_not_exists(sk)",
      Item: { kind: "ai_notes" },
    });
    // The transcript itself is never stored on the message.
    expect(JSON.stringify(put.Item)).not.toContain("review the contract");

    expect(sentEvents().map(([id, e]) => `${id}:${e.type}`)).toEqual([
      "conn-alice:message.new",
      "conn-bob:message.new",
    ]);

    const invoke = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(invoke.FunctionName).toBe("slack-test-call-notes-worker");
    expect(invoke.InvocationType).toBe("Event");
    const job = JSON.parse(new TextDecoder().decode(invoke.Payload as Uint8Array));
    expect(job).toMatchObject({
      card: {
        channelId: DM,
        sk: body.message.sk,
        messageId: body.message.messageId,
        members: [ALICE.userId, BOB.userId],
      },
      notes: { status: "pending" },
      segments: summary().segments,
    });
  });

  it("returns the card already posted for a repeated request, starting nothing", async () => {
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({
      Items: [
        {
          messageId: "m1",
          channelId: DM,
          sk: "1#m1",
          userId: ALICE.userId,
          kind: "ai_notes",
          clientId: "ai-notes:01CALLCALLCALLCALLCALLCALL",
        },
      ],
    });
    const { status, body } = await call(summary());
    expect(status).toBe(202);
    expect(body.message.messageId).toBe("m1");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("refuses outsiders, channels that aren't DMs, strangers' speech and bad bodies", async () => {
    expect((await call(summary(), CAROL)).status).toBe(404);
    expect((await call(summary({ channelId: GENERAL_CHANNEL_ID }))).status).toBe(404);
    const stranger = await call(
      summary({ segments: [{ userId: CAROL.userId, text: "hi", at: NOW - 1000 }] }),
    );
    expect(stranger.status).toBe(400);
    expect(stranger.body.message).toContain("isn't part of this conversation");
    expect((await call(summary({ segments: [] }))).status).toBe(400);
    expect((await call({ ...summary(), callId: undefined })).status).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("refuses a transcript too big to hand to the worker, never cutting it", async () => {
    // Within the character limit, but four bytes per character in UTF-8.
    const segments = Array.from({ length: 60 }, (_, i) => ({
      userId: ALICE.userId,
      text: "😀".repeat(999),
      at: NOW - 500_000 + i,
    }));
    const { status } = await call(summary({ segments }));
    expect(status).toBe(413);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("marks the card failed and answers 502 when the worker can't be started", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("TooManyRequestsException"));
    const { status } = await call(summary());
    expect(status).toBe(502);
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.ExpressionAttributeValues?.[":notes"]).toMatchObject({
      status: "failed",
      error: "The notes couldn't be started.",
    });
  });
});
