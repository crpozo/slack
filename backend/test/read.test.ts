import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ChannelReadEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/read";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

const SK = "1700000000000#01HZZZZZZZZZZZZZZZZZZZZZZZ";
const conditionFailed = () => new ConditionalCheckFailedException({ message: "no", $metadata: {} });
const missingMap = () =>
  Object.assign(new Error("The document path provided in the update expression is invalid"), {
    name: "ValidationException",
  });
const read = (body: object = {}) =>
  handler(wsEvent("read", { action: "read", channelId: "ch_general", sk: SK, ...body }));

describe("read", () => {
  beforeEach(() => {
    resetMocks();
    mockChannels(GENERAL, privateRow("ch_team", BOB.userId, [BOB.userId]));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
  });

  it("moves the caller's watermark forward with one conditional write and tells the channel", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    expect((await read()).statusCode).toBe(200);

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    const input = updates[0]!.args[0].input;
    expect(input.Key).toEqual({ channelId: "ch_general" });
    expect(input.UpdateExpression).toBe("SET #reads.#u = :mark");
    expect(input.ConditionExpression).toContain("#reads.#u.sk < :sk");
    expect(input.ExpressionAttributeNames).toEqual({ "#reads": "reads", "#u": ALICE.userId });
    expect(input.ExpressionAttributeValues?.[":mark"]).toEqual({ sk: SK, at: expect.any(Number) });

    const events = sentEvents().map(([, e]) => e as ChannelReadEvent);
    expect(events).toHaveLength(2); // the reader's own tabs too
    expect(events[0]).toEqual({
      type: "channel.read",
      channelId: "ch_general",
      userId: ALICE.userId,
      sk: SK,
      at: expect.any(Number),
    });
  });

  it("creates the reads map on a channel read for the first time", async () => {
    ddbMock.on(UpdateCommand).rejectsOnce(missingMap()).resolves({});
    expect((await read()).statusCode).toBe(200);
    const expressions = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(expressions.map((i) => i.UpdateExpression)).toEqual([
      "SET #reads.#u = :mark",
      "SET #reads = :reads",
    ]);
    expect(expressions[1]!.ExpressionAttributeValues?.[":reads"]).toEqual({
      [ALICE.userId]: { sk: SK, at: expect.any(Number) },
    });
    expect(sentEvents()).toHaveLength(2);
  });

  it("is silent when the watermark is already past that message", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    expect((await read()).statusCode).toBe(200);
    expect(sentEvents()).toEqual([]);
  });

  it("answers CHANNEL_NOT_FOUND for channels the caller can't see", async () => {
    await read({ channelId: "ch_team" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sentEvents()).toMatchObject([
      ["conn-alice", { type: "error", code: "CHANNEL_NOT_FOUND" }],
    ]);
  });
});
