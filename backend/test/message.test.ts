import { GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId, GENERAL_CHANNEL_ID, compareIds } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/message";
import {
  ALICE,
  apiMock,
  BOB,
  ddbMock,
  dmRow,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

const send = (body: unknown, opts?: Parameters<typeof wsEvent>[2]) =>
  handler(wsEvent("message", body, opts));

describe("message", () => {
  beforeEach(() => {
    resetMocks();
    mockChannels(GENERAL);
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
  });

  it("persists the message and broadcasts message.new to everyone, sender included", async () => {
    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "hola",
      clientId: "c1",
    });

    expect(result.statusCode).toBe(200);
    const stored = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(stored?.TableName).toBe("slack-test-messages");
    expect(stored?.Item).toMatchObject({
      channelId: GENERAL_CHANNEL_ID,
      userId: ALICE.userId,
      userEmail: ALICE.email,
      text: "hola",
      attachments: [],
    });
    expect(stored?.Item?.sk).toMatch(/^\d{13}#[0-9A-Z]{26}$/);

    const sent = sentEvents();
    expect(sent.map(([id]) => id).sort(compareIds)).toEqual(["conn-alice", "conn-bob"]);
    for (const [, event] of sent) {
      expect(event).toEqual({ type: "message.new", message: stored?.Item, clientId: "c1" });
    }
  });

  it("rejects an invalid payload with BAD_REQUEST and stores nothing", async () => {
    const result = await send({ action: "message", channelId: GENERAL_CHANNEL_ID });

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "BAD_REQUEST" })],
    ]);
  });

  it("rejects invalid JSON", async () => {
    const result = await handler(wsEvent("message", "{not json"));
    expect(result.statusCode).toBe(400);
  });

  it("rejects an empty message without attachments", async () => {
    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "  ",
      clientId: "c",
    });
    expect(result.statusCode).toBe(400);
  });

  it("rejects attachments from another channel", async () => {
    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "",
      clientId: "c",
      attachments: [
        { key: "attachments/ch_other/x.png", name: "x.png", size: 1, contentType: "image/png" },
      ],
    });
    expect(result.statusCode).toBe(400);
  });

  it("returns CHANNEL_NOT_FOUND for an unknown channel", async () => {
    ddbMock.on(GetCommand, { TableName: "slack-test-channels" }).resolves({});

    const result = await send({
      action: "message",
      channelId: "ch_nope",
      text: "hola",
      clientId: "c",
    });

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "CHANNEL_NOT_FOUND" })],
    ]);
  });

  it("refuses to post in a DM the sender is not part of", async () => {
    const result = await send({
      action: "message",
      channelId: dmChannelId("user-x", "user-y"),
      text: "hola",
      clientId: "c",
    });
    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("only delivers DM messages to the participants", async () => {
    const dm = dmChannelId(ALICE.userId, BOB.userId);
    mockChannels(GENERAL, dmRow(ALICE.userId, BOB.userId));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
        { connectionId: "conn-eve", userId: "user-eve" },
      ],
    });

    await send({ action: "message", channelId: dm, text: "psst", clientId: "c" });

    expect(
      sentEvents()
        .map(([id]) => id)
        .sort(compareIds),
    ).toEqual(["conn-alice", "conn-bob"]);
  });

  it("hides private channels from non-members", async () => {
    mockChannels(GENERAL, privateRow("ch_team", BOB.userId, [BOB.userId]));
    const result = await send({
      action: "message",
      channelId: "ch_team",
      text: "hola",
      clientId: "c",
    });
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "CHANNEL_NOT_FOUND" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("delivers private channel messages to members only", async () => {
    mockChannels(GENERAL, privateRow("ch_team", ALICE.userId, [ALICE.userId, BOB.userId]));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
        { connectionId: "conn-eve", userId: "user-eve" },
      ],
    });

    await send({ action: "message", channelId: "ch_team", text: "equipo", clientId: "c" });

    expect(
      sentEvents()
        .map(([id]) => id)
        .sort(compareIds),
    ).toEqual(["conn-alice", "conn-bob"]);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.reactions).toEqual({});
  });

  it("deletes connections that answer 410 Gone", async () => {
    apiMock
      .on(PostToConnectionCommand, { ConnectionId: "conn-bob" })
      .rejects(new GoneException({ message: "gone", $metadata: {} }));
    ddbMock.on(DeleteCommand).resolves({});

    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "hola",
      clientId: "c",
    });

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input)).toEqual([
      { TableName: "slack-test-connections", Key: { connectionId: "conn-bob" } },
    ]);
  });

  it("falls back to the connections table when there is no authorizer context", async () => {
    ddbMock
      .on(GetCommand, { TableName: "slack-test-connections" })
      .resolves({ Item: { userId: BOB.userId, userEmail: BOB.email } });

    await send(
      { action: "message", channelId: GENERAL_CHANNEL_ID, text: "hola", clientId: "c" },
      { user: null, connectionId: "conn-bob" },
    );

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      userId: BOB.userId,
      userEmail: BOB.email,
    });
  });

  it("answers UNAUTHORIZED for an unknown connection", async () => {
    ddbMock.on(GetCommand, { TableName: "slack-test-connections" }).resolves({});

    const result = await send(
      { action: "message", channelId: GENERAL_CHANNEL_ID, text: "hola", clientId: "c" },
      { user: null },
    );

    expect(result.statusCode).toBe(400);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "UNAUTHORIZED" })],
    ]);
  });

  it("answers INTERNAL_ERROR when DynamoDB fails", async () => {
    ddbMock.on(PutCommand).rejects(new Error("boom"));

    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "hola",
      clientId: "c",
    });

    expect(result.statusCode).toBe(500);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "INTERNAL_ERROR" })],
    ]);
  });
});
