import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handler } from "../src/handlers/nudge";
import * as push from "../src/lib/push";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

const nudge = (toUserId: string) => handler(wsEvent("nudge", { action: "nudge", toUserId }));

describe("nudge", () => {
  let sendPush: MockInstance<typeof push.sendPush>;
  beforeEach(() => {
    resetMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    sendPush = vi.spyOn(push, "sendPush").mockResolvedValue(1);
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { displayName: "Alicia" } });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
  });

  it("reaches the recipient's open tabs only, and rate-limits per pair", async () => {
    expect((await nudge(BOB.userId)).statusCode).toBe(200);

    expect(sentEvents()).toEqual([["conn-bob", { type: "user.nudge", from: ALICE.userId }]]);
    expect(sendPush).not.toHaveBeenCalled();
    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.Key).toEqual({ userId: BOB.userId });
    expect(update?.ExpressionAttributeNames).toEqual({ "#last": `nudgedAt_${ALICE.userId}` });
    expect(update?.ExpressionAttributeValues).toEqual({
      ":now": 1_700_000_000_000,
      ":cutoff": 1_700_000_000_000 - 60_000,
    });
  });

  it("sends a Web Push when they have no tab open", async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [{ connectionId: "conn-alice", userId: ALICE.userId }] });
    await nudge(BOB.userId);
    expect(sendPush).toHaveBeenCalledWith([BOB.userId], {
      title: "👋 Alicia is pinging you",
      body: "Open Slack to reply",
      url: `/app/${encodeURIComponent(dmChannelId(ALICE.userId, BOB.userId))}`,
      // Grouped with the DM's own notifications.
      tag: dmChannelId(ALICE.userId, BOB.userId),
    });
  });

  it("answers RATE_LIMITED within a minute, USER_NOT_FOUND for unknown people", async () => {
    // The row exists (Item returned) but the last nudge is too recent.
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "x",
        $metadata: {},
        Item: { userId: { S: BOB.userId } },
      }),
    );
    expect((await nudge(BOB.userId)).statusCode).toBe(400);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "RATE_LIMITED" });

    // No row at all: nobody to nudge.
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect((await nudge("user-ghost")).statusCode).toBe(400);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "USER_NOT_FOUND" });
    expect(sentEvents().some(([, e]) => e.type === "user.nudge")).toBe(false);
  });

  it("refuses nudging yourself and malformed ids", async () => {
    expect((await nudge(ALICE.userId)).statusCode).toBe(400);
    expect((await nudge("bad_id")).statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
