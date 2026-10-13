import { compareIds } from "@mindfultech/shared";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { UserListEvent, UserUpdatedEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/user";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

describe("user", () => {
  beforeEach(() => {
    resetMocks();
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
