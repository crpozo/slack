import { GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { dmChannelId, GENERAL_CHANNEL_ID, compareIds, type Attachment } from "@mindfultech/shared";
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
    ddbMock.on(QueryCommand).resolves({ Items: [] }); // no earlier send of this clientId
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
      clientId: "c1", // stored, so a retry is recognized
    });
    expect(stored?.Item?.sk).toMatch(/^\d{13}#[0-9A-Z]{26}$/);

    const sent = sentEvents();
    expect(sent.map(([id]) => id).sort(compareIds)).toEqual(["conn-alice", "conn-bob"]);
    for (const [, event] of sent) {
      expect(event).toEqual({ type: "message.new", message: stored?.Item, clientId: "c1" });
    }
  });

  it("stores a secret with a 7-day TTL (epoch seconds) and refuses one with files", async () => {
    const before = Date.now();
    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "hunter2",
      clientId: "c1",
      isSecret: true,
    });
    expect(result.statusCode).toBe(200);
    const stored = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as {
      isSecret?: boolean;
      expiresAt?: number;
    };
    expect(stored.isSecret).toBe(true);
    const week = 7 * 24 * 3600;
    expect(stored.expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) + week);
    expect(stored.expiresAt).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + week);

    const withFile = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "hunter2",
      clientId: "c2",
      isSecret: true,
      attachments: [
        { key: `attachments/${GENERAL_CHANNEL_ID}/k`, name: "k", size: 1, contentType: "x/y" },
      ],
    });
    expect(withFile.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
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

  it("rejects a thumbnail from another channel, and signs download URLs for images", async () => {
    const base = { action: "message", channelId: GENERAL_CHANNEL_ID, text: "", clientId: "c9" };
    await send({
      ...base,
      attachments: [
        {
          key: "attachments/ch_general/x.png",
          thumbKey: "attachments/ch_other/x.webp",
          name: "x.png",
          size: 1,
          contentType: "image/png",
        },
      ],
    });
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "error", code: "BAD_REQUEST" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);

    await send({
      ...base,
      attachments: [
        {
          key: "attachments/ch_general/x.png",
          thumbKey: "attachments/ch_general/x.webp",
          name: "x.png",
          size: 1,
          contentType: "image/png",
          width: 640,
          height: 480,
        },
      ],
    });
    const stored = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(stored.attachments[0]).not.toHaveProperty("url");
    expect(stored.attachments[0]).toMatchObject({ width: 640, height: 480 });
    const [, event] = sentEvents()[1] as [string, { message: { attachments: Attachment[] } }];
    expect(event.message.attachments[0]?.url).toMatch(/\/attachments\/ch_general\/x\.png\?/);
    expect(event.message.attachments[0]?.thumbUrl).toMatch(/x\.webp\?/);
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

describe("message replies", () => {
  const original = {
    channelId: GENERAL_CHANNEL_ID,
    sk: "1700000000000#01JORIGINAL0000000000000000",
    messageId: "01JORIGINAL0000000000000000",
    userId: BOB.userId,
    text: `  long\n${"x".repeat(200)}  `,
    attachments: [{ key: "attachments/ch_general/a.png" }],
  };
  beforeEach(() => {
    resetMocks();
    mockChannels(GENERAL);
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [{ connectionId: "conn-alice", userId: ALICE.userId }] });
    ddbMock.on(GetCommand, { TableName: "slack-test-messages" }).resolves({});
    ddbMock
      .on(GetCommand, {
        TableName: "slack-test-messages",
        Key: { channelId: GENERAL_CHANNEL_ID, sk: original.sk },
      })
      .resolves({ Item: original });
  });
  const reply = (replyTo: { messageId: string; sk: string }, channelId = GENERAL_CHANNEL_ID) =>
    send({ action: "message", channelId, text: "agreed", clientId: "c9", replyTo });

  it("stores a snapshot of the quoted message", async () => {
    expect((await reply({ messageId: original.messageId, sk: original.sk })).statusCode).toBe(200);
    const stored = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(stored?.replyTo).toEqual({
      messageId: original.messageId,
      sk: original.sk,
      userId: BOB.userId,
      preview: `long ${"x".repeat(134)}…`,
      hasAttachments: true,
    });
    expect((stored?.replyTo as { preview: string }).preview).toHaveLength(140);
  });

  it("quotes a secret as 🔒 Secret, never its text", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "slack-test-messages",
        Key: { channelId: GENERAL_CHANNEL_ID, sk: original.sk },
      })
      .resolves({ Item: { ...original, text: "hunter2", isSecret: true } });
    await reply({ messageId: original.messageId, sk: original.sk });
    const stored = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect((stored?.replyTo as { preview: string }).preview).toBe("🔒 Secret");
    expect(JSON.stringify(stored)).not.toContain("hunter2");
  });

  it("refuses to quote a message that isn't in this channel or doesn't match", async () => {
    expect((await reply({ messageId: original.messageId, sk: "nope" })).statusCode).toBe(400);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    expect((await reply({ messageId: "OTHER", sk: original.sk })).statusCode).toBe(400);
    // The lookup is always keyed by the channel being written to.
    expect(
      ddbMock
        .commandCalls(GetCommand)
        .filter((c) => c.args[0].input.TableName === "slack-test-messages")
        .every(
          (c) => (c.args[0].input.Key as { channelId: string }).channelId === GENERAL_CHANNEL_ID,
        ),
    ).toBe(true);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("message retries", () => {
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

  it("stores a retried clientId only once and confirms the stored copy to the sender", async () => {
    const stored = {
      messageId: "m1",
      channelId: GENERAL_CHANNEL_ID,
      sk: "1#m1",
      userId: ALICE.userId,
      text: "hola",
      clientId: "c1",
    };
    ddbMock.on(QueryCommand).resolves({ Items: [stored] });

    const result = await send({
      action: "message",
      channelId: GENERAL_CHANNEL_ID,
      text: "hola",
      clientId: "c1",
    });

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([
      [
        "conn-alice",
        { type: "message.new", message: { ...stored, reactions: {} }, clientId: "c1" },
      ],
    ]);
    const query = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(query).toMatchObject({ ScanIndexForward: false, Limit: 25 });
  });

  it("another person's message with the same clientId is not a duplicate", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ messageId: "m1", userId: BOB.userId, clientId: "c1" }],
    });
    await send({ action: "message", channelId: GENERAL_CHANNEL_ID, text: "hola", clientId: "c1" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
