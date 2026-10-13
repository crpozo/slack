import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { dmChannelId, type ChannelListEvent, compareIds } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/channel";
import {
  ALICE,
  apiMock,
  BOB,
  ddbMock,
  dmRow,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

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

  it("create makes channels private by default, with the creator as only member", async () => {
    mockScans([general]);
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "secreto" }),
    );

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      name: "secreto",
      type: "private",
      createdBy: ALICE.userId,
      members: [ALICE.userId],
    });
  });

  it("create stores a public channel when asked and broadcasts channel.list", async () => {
    mockScans([general]);
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "dev", visibility: "public" }),
    );

    expect(result.statusCode).toBe(200);
    const put = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(put?.Item).toMatchObject({
      name: "dev",
      type: "public",
      createdBy: ALICE.userId,
      archived: false,
    });
    expect(put?.Item?.members).toBeUndefined();
    expect(put?.Item?.channelId).toMatch(/^ch_[0-9A-Z]{26}$/);
    expect(
      sentEvents()
        .map(([id, e]) => [id, e.type])
        .sort(([a], [b]) => compareIds(a ?? "", b ?? "")),
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

  it("create rejects names without letters or numbers, or with control characters", async () => {
    for (const name of ["!!!", "   ", "bad\u0007name", "x".repeat(41)]) {
      resetMocks();
      const result = await handler(wsEvent("channel", { action: "channel", op: "create", name }));
      expect(result.statusCode).toBe(400);
      expect(sentEvents()[0]?.[1]).toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("create keeps the readable name and stores its slug", async () => {
    mockScans([general]);
    ddbMock.on(PutCommand).resolves({});

    await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "  Diseño Web  " }),
    );

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      name: "Diseño Web",
      slug: "diseno-web",
    });
  });

  it("create treats names with the same slug as duplicates (old rows have no slug)", async () => {
    mockScans([general, { ...general, channelId: "ch_x", name: "Web Design", slug: "web-design" }]);
    for (const name of ["General", "web design", "WEB-DESIGN"]) {
      apiMock.resetHistory();
      const result = await handler(wsEvent("channel", { action: "channel", op: "create", name }));
      expect(result.statusCode).toBe(400);
      expect(sentEvents()[0]?.[1]).toMatchObject({ code: "CHANNEL_NAME_TAKEN" });
    }
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
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
    expect(first?.Item).toMatchObject({
      type: "dm",
      members: [ALICE.userId, BOB.userId].sort(compareIds),
    });
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

  it("list includes private channels only for their members", async () => {
    const team = privateRow("ch_team", ALICE.userId, [ALICE.userId]);
    mockScans([general, team]);

    await handler(wsEvent("channel", { action: "channel", op: "list" }));
    await handler(
      wsEvent(
        "channel",
        { action: "channel", op: "list" },
        { user: BOB, connectionId: "conn-bob" },
      ),
    );

    const [alice, bob] = sentEvents() as Array<[string, ChannelListEvent]>;
    expect(alice?.[1].channels.map((c) => c.channelId)).toEqual(["ch_general", "ch_team"]);
    expect(bob?.[1].channels.map((c) => c.channelId)).toEqual(["ch_general"]);
  });

  it("create rejects a name already used by a private channel", async () => {
    mockScans([general, privateRow("ch_team", BOB.userId, [BOB.userId])]);
    const result = await handler(
      wsEvent("channel", { action: "channel", op: "create", name: "team", visibility: "public" }),
    );
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "CHANNEL_NAME_TAKEN" });
  });
});

describe("channel invite", () => {
  const invite = (userIds: string[], user = ALICE, channelId = "ch_team") =>
    handler(
      wsEvent(
        "channel",
        { action: "channel", op: "invite", channelId, userIds },
        { user, connectionId: user === ALICE ? "conn-alice" : "conn-bob" },
      ),
    );

  beforeEach(() => {
    resetMocks();
    mockChannels(
      general as never,
      privateRow("ch_team", ALICE.userId, [ALICE.userId, "user-carol"]),
    );
    ddbMock.on(ScanCommand, { TableName: "slack-test-channels" }).resolves({ Items: [general] });
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-connections" })
      .resolves({ Items: connections });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { "slack-test-users": [{ userId: BOB.userId }, { userId: "user-dave" }] },
    });
    ddbMock.on(UpdateCommand).resolves({});
  });

  it("lets the creator add existing users and broadcasts the new lists", async () => {
    const result = await invite([BOB.userId, BOB.userId, "user-dave"]);

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems).toEqual({
      "slack-test-users": {
        Keys: [{ userId: BOB.userId }, { userId: "user-dave" }],
        ProjectionExpression: "userId",
      },
    });
    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.Key).toEqual({ channelId: "ch_team" });
    expect(update?.ExpressionAttributeValues?.[":members"]).toEqual(
      [ALICE.userId, BOB.userId, "user-carol", "user-dave"].sort(compareIds),
    );
    expect(update?.ConditionExpression).toBe("createdBy = :me AND #type = :private");
    expect(sentEvents().every(([, e]) => e.type === "channel.list")).toBe(true);
  });

  it("retries keys BatchGet left unprocessed once before accepting the invitees", async () => {
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { "slack-test-users": [{ userId: BOB.userId }] },
        UnprocessedKeys: { "slack-test-users": { Keys: [{ userId: "user-dave" }] } },
      })
      .resolvesOnce({ Responses: { "slack-test-users": [{ userId: "user-dave" }] } });

    const result = await invite([BOB.userId, "user-dave"]);

    expect(result.statusCode).toBe(200);
    const calls = ddbMock.commandCalls(BatchGetCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.RequestItems?.["slack-test-users"]?.Keys).toEqual([
      { userId: "user-dave" },
    ]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("treats keys still unprocessed after the retry as unknown users", async () => {
    const unprocessed = { "slack-test-users": { Keys: [{ userId: "user-dave" }] } };
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { "slack-test-users": [] }, UnprocessedKeys: unprocessed })
      .resolvesOnce({ Responses: { "slack-test-users": [] }, UnprocessedKeys: unprocessed });

    const result = await invite(["user-dave"]);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(2);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "USER_NOT_FOUND" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("answers FORBIDDEN to members who did not create the channel", async () => {
    mockChannels(privateRow("ch_team", ALICE.userId, [ALICE.userId, BOB.userId]));
    const result = await invite(["user-dave"], BOB);
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "FORBIDDEN" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("hides the channel from non-members", async () => {
    const result = await invite(["user-dave"], BOB);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "CHANNEL_NOT_FOUND" });
    expect(result.statusCode).toBe(400);
  });

  it("refuses unknown users", async () => {
    const result = await invite([BOB.userId, "user-ghost"]);
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "USER_NOT_FOUND" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("refuses invitations to public channels", async () => {
    const result = await invite([BOB.userId], ALICE, "ch_general");
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("channel delete", () => {
  const remove = (channelId: string, user = ALICE) =>
    handler(
      wsEvent(
        "channel",
        { action: "channel", op: "delete", channelId },
        { user, connectionId: user === ALICE ? "conn-alice" : "conn-bob" },
      ),
    );
  const publicRow = { ...general, channelId: "ch_pub", name: "Pub", createdBy: ALICE.userId };
  const dm = dmRow(ALICE.userId, BOB.userId);
  const allConnections = [...connections, { connectionId: "conn-carol", userId: "user-carol" }];

  beforeEach(() => {
    resetMocks();
    mockChannels(
      general as never,
      publicRow as never,
      dm,
      privateRow("ch_team", ALICE.userId, [ALICE.userId, BOB.userId]),
    );
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-connections" })
      .resolves({ Items: allConnections });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
  });

  it("deletes the creator's channel and its messages in batches of 25", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ channelId: "ch_pub", sk: `${i}#x` }));
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await remove("ch_pub");

    expect(result.statusCode).toBe(200);
    const batches = ddbMock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input);
    expect(batches.map((b) => b.RequestItems?.["slack-test-messages"]?.length)).toEqual([25, 5]);
    expect(batches[0]?.RequestItems?.["slack-test-messages"]?.[0]).toEqual({
      DeleteRequest: { Key: { channelId: "ch_pub", sk: "0#x" } },
    });
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input).toEqual({
      TableName: "slack-test-channels",
      Key: { channelId: "ch_pub" },
    });
    // Public: everyone hears about it.
    expect(sentEvents().map(([id]) => id)).toEqual(["conn-alice", "conn-bob", "conn-carol"]);
    expect(sentEvents()[0]?.[1]).toEqual({
      type: "channel.deleted",
      channelId: "ch_pub",
      by: ALICE.userId,
    });
  });

  it("retries messages BatchWrite left unprocessed", async () => {
    const items = [{ channelId: "ch_pub", sk: "1#a" }];
    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          "slack-test-messages": [{ DeleteRequest: { Key: items[0] } }],
        },
      })
      .resolves({});

    expect((await remove("ch_pub")).statusCode).toBe(200);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it("lets either member delete a DM and only tells its members", async () => {
    const result = await remove(dm.channelId, BOB);

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(sentEvents().map(([id, e]) => [id, e.type])).toEqual([
      ["conn-alice", "channel.deleted"],
      ["conn-bob", "channel.deleted"],
    ]);
  });

  it("only tells members of a private channel", async () => {
    await remove("ch_team");
    expect(sentEvents().map(([id]) => id)).toEqual(["conn-alice", "conn-bob"]);
  });

  it("refuses #general, other people's channels and channels you can't see", async () => {
    expect((await remove("ch_general")).statusCode).toBe(400);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "FORBIDDEN" });

    expect((await remove("ch_pub", BOB)).statusCode).toBe(400);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "FORBIDDEN" });

    mockChannels(privateRow("ch_secret", BOB.userId, [BOB.userId]));
    expect((await remove("ch_secret")).statusCode).toBe(400);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "CHANNEL_NOT_FOUND" });

    expect((await remove("ch_missing")).statusCode).toBe(400);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});
