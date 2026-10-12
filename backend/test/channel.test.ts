import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId, type ChannelListEvent, compareIds } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/channel";
import {
  ALICE,
  BOB,
  ddbMock,
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
