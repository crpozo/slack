import { compareIds } from "@mindfultech/shared";
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { UserListEvent, UserUpdatedEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/user";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

describe("user", () => {
  beforeEach(() => {
    resetMocks();
    ddbMock.on(GetCommand).resolves({}); // no pinned chats
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
  });

  it("list returns the directory sorted by display name, with defaults filled in", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [
        { userId: BOB.userId, email: BOB.email, displayName: "Zoe", updatedAt: 5 },
        { userId: ALICE.userId, email: ALICE.email },
      ],
    });

    const result = await handler(wsEvent("user", { action: "user", op: "list" }));

    expect(result.statusCode).toBe(200);
    const [[connectionId, event]] = sentEvents() as [[string, UserListEvent]];
    expect(connectionId).toBe("conn-alice");
    expect(event.users).toEqual([
      { userId: ALICE.userId, email: ALICE.email, displayName: "alice", updatedAt: 0 },
      { userId: BOB.userId, email: BOB.email, displayName: "Zoe", updatedAt: 5 },
    ]);
    // Presence snapshot: everyone with a live connection.
    expect(event.online).toEqual([ALICE.userId, BOB.userId].sort());
  });

  it("update sets the caller's own display name and broadcasts user.updated to everyone", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { userId: ALICE.userId, email: ALICE.email, displayName: "Alicia", updatedAt: 9 },
    });

    const result = await handler(
      wsEvent("user", {
        action: "user",
        op: "update",
        displayName: "  Alicia  ",
        userId: BOB.userId,
      }),
    );

    expect(result.statusCode).toBe(200);
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ userId: ALICE.userId }); // never the payload's userId
    expect(input?.ExpressionAttributeValues?.[":name"]).toBe("Alicia");
    const sent = sentEvents() as Array<[string, UserUpdatedEvent]>;
    expect(sent.map(([id]) => id).sort(compareIds)).toEqual(["conn-alice", "conn-bob"]);
    expect(sent[0]?.[1]).toEqual({
      type: "user.updated",
      user: { userId: ALICE.userId, email: ALICE.email, displayName: "Alicia", updatedAt: 9 },
    });
  });

  it("rejects empty, too long or control-character display names", async () => {
    for (const displayName of ["   ", "x".repeat(41), "a\u0007b"]) {
      const result = await handler(wsEvent("user", { action: "user", op: "update", displayName }));
      expect(result.statusCode, JSON.stringify(displayName)).toBe(400);
    }
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("user: pins and guests", () => {
  beforeEach(() => {
    resetMocks();
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-alice-2", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
  });

  it("list also sends the caller their pinned chats", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: { pinned: ["dm_a_b"] } });
    await handler(wsEvent("user", { action: "user", op: "list" }));
    expect(sentEvents().map(([, e]) => e)).toContainEqual({
      type: "user.prefs",
      pinned: ["dm_a_b"],
    });
  });

  it("pin puts the chat first, keeps it unique, and syncs the caller's own tabs only", async () => {
    const dm = `dm_${[ALICE.userId, BOB.userId].sort(compareIds).join("_")}`;
    ddbMock.on(GetCommand, { TableName: "slack-test-users" }).resolves({
      Item: { pinned: ["dm_other", dm] },
    });
    ddbMock.on(GetCommand, { TableName: "slack-test-channels" }).resolves({
      Item: { channelId: dm, type: "dm", members: [ALICE.userId, BOB.userId] },
    });
    await handler(wsEvent("user", { action: "user", op: "pin", channelId: dm, pinned: true }));
    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.Key).toEqual({ userId: ALICE.userId });
    expect(update?.ExpressionAttributeValues).toEqual({ ":pinned": [dm, "dm_other"] });
    expect(sentEvents()).toEqual([
      ["conn-alice", { type: "user.prefs", pinned: [dm, "dm_other"] }],
      ["conn-alice-2", { type: "user.prefs", pinned: [dm, "dm_other"] }],
    ]);
  });

  it("refuses pinning a conversation you can't see", async () => {
    ddbMock.on(GetCommand).resolves({});
    await handler(
      wsEvent("user", { action: "user", op: "pin", channelId: "dm_x_y", pinned: true }),
    );
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "CHANNEL_NOT_FOUND" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("a guest's directory is only the people on their boards, without presence", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [
        { userId: ALICE.userId, email: ALICE.email },
        { userId: BOB.userId, email: BOB.email },
        { userId: "user-guest", email: "client@acme.com", role: "guest" },
      ],
    });
    ddbMock.on(QueryCommand).resolves({ Items: [{ boardId: "b_1" }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "slack-test-boards": [
          {
            boardId: "b_1",
            sk: "BOARD",
            name: "Site",
            ownerId: BOB.userId,
            members: ["user-guest"],
          },
        ],
      },
    });
    await handler(
      wsEvent(
        "user",
        { action: "user", op: "list" },
        { user: { userId: "user-guest", email: "client@acme.com", role: "guest" } },
      ),
    );
    const [[, event]] = sentEvents() as [[string, UserListEvent]];
    expect(event.users.map((u) => u.userId).sort()).toEqual([BOB.userId, "user-guest"].sort());
    expect(event.online).toBeUndefined();
    expect(sentEvents()).toHaveLength(1); // no prefs for guests
  });
});
