import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId, type ChannelListEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/channel";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

const general = {
  channelId: "ch_general",
  name: "general",
  type: "public",
  createdBy: "system",
  createdAt: 1,
  archived: false,
};
const archived = {
  channelId: "ch_old",
  name: "old",
  type: "public",
  createdBy: "x",
  createdAt: 2,
  archived: true,
};
const foreignDm = {
  channelId: dmChannelId("user-x", "user-y"),
  name: "dm",
  type: "dm",
  createdBy: "user-x",
  createdAt: 3,
  archived: false,
  members: ["user-x", "user-y"],
};
const connections = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
];

function mockScans(channels: object[]) {
  ddbMock.on(ScanCommand, { TableName: "slack-test-channels" }).resolves({ Items: channels });
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({ Items: connections });
}

describe("channel", () => {
  beforeEach(resetMocks);

  it("list returns visible channels only to the sender", async () => {
    mockScans([general, archived, foreignDm]);

    const result = await handler(wsEvent("channel", { action: "channel", op: "list" }));

    expect(result.statusCode).toBe(200);
    expect(sentEvents()).toEqual([["conn-alice", { type: "channel.list", channels: [general] }]]);
  });

  it("create stores a public channel and broadcasts channel.list", async () => {
    mockScans([general]);
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "dev" }),
    );

    expect(result.statusCode).toBe(200);
    const put = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(put?.Item).toMatchObject({
      name: "dev",
      type: "public",
      createdBy: ALICE.userId,
      archived: false,
    });
    expect(put?.Item?.channelId).toMatch(/^ch_[0-9A-Z]{26}$/);
    expect(
      sentEvents()
        .map(([id, e]) => [id, e.type])
        .sort(),
    ).toEqual([
      ["conn-alice", "channel.list"],
      ["conn-bob", "channel.list"],
    ]);
  });

  it("create rejects a duplicate name", async () => {
    mockScans([general]);

    const result = await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "general" }),
    );

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "CHANNEL_NAME_TAKEN" })],
    ]);
  });

  it("create rejects an invalid name", async () => {
    const result = await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "Not Valid" }),
    );
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("dm generates the same id regardless of who opens it", async () => {
    mockScans([general]);
    ddbMock.on(PutCommand).resolves({});

    await handler(wsEvent("channel", { action: "channel", op: "dm", withUserId: BOB.userId }));
    await handler(
      wsEvent(
        "channel",
        { action: "channel", op: "dm", withUserId: ALICE.userId },
        { user: BOB, connectionId: "conn-bob" },
      ),
    );

    const [first, second] = ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input);
    expect(first?.Item?.channelId).toBe(dmChannelId(ALICE.userId, BOB.userId));
    expect(second?.Item?.channelId).toBe(first?.Item?.channelId);
    expect(first?.Item).toMatchObject({ type: "dm", members: [ALICE.userId, BOB.userId].sort() });
    expect(first?.ConditionExpression).toBe("attribute_not_exists(channelId)");
  });

  it("dm that already exists still broadcasts the list", async () => {
    const dm = {
      ...foreignDm,
      channelId: dmChannelId(ALICE.userId, BOB.userId),
      members: [ALICE.userId, BOB.userId],
    };
    mockScans([general, dm]);
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));

    const result = await handler(
      wsEvent("channel", { action: "channel", op: "dm", withUserId: BOB.userId }),
    );

    expect(result.statusCode).toBe(200);
    const lists = sentEvents() as Array<[string, ChannelListEvent]>;
    for (const [, event] of lists)
      expect(event.channels.map((c) => c.channelId)).toEqual(["ch_general", dm.channelId]);
  });

  it("dm rejects user ids containing '_'", async () => {
    const result = await handler(
      wsEvent("channel", { action: "channel", op: "dm", withUserId: "a_b" }),
    );
    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
