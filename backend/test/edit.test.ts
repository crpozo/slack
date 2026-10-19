import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { MessageUpdatedEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/edit";
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
const conditionFailed = (Item?: Record<string, unknown>) =>
  new ConditionalCheckFailedException({ message: "no", $metadata: {}, Item: Item as never });
const edit = (body: object = {}) =>
  handler(
    wsEvent("edit", { action: "edit", channelId: "ch_general", sk: SK, text: "hola!", ...body }),
  );

describe("edit", () => {
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

  it("rewrites the caller's own message and broadcasts message.updated", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { messageId: "m1", text: "hola!" } });
    expect((await edit()).statusCode).toBe(200);

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ channelId: "ch_general", sk: SK });
    expect(input.ConditionExpression).toBe(
      "attribute_exists(sk) AND userId = :me AND attribute_not_exists(isSecret) AND attribute_not_exists(kind)",
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":text": "hola!",
      ":me": ALICE.userId,
    });

    const events = sentEvents().map(([, e]) => e as MessageUpdatedEvent);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "message.updated",
      channelId: "ch_general",
      sk: SK,
      messageId: "m1",
      text: "hola!",
      isEdited: true,
      editedAt: expect.any(Number),
    });
  });

  it("trims the text and rejects an empty edit", async () => {
    await edit({ text: "   " });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sentEvents()[0]![1]).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  });

  it("refuses someone else's message (FORBIDDEN)", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed({ userId: BOB.userId }));
    await edit();
    expect(sentEvents().at(-1)![1]).toMatchObject({ type: "error", code: "FORBIDDEN" });
  });

  it("answers MESSAGE_NOT_FOUND for a message that doesn't exist", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    await edit();
    expect(sentEvents().at(-1)![1]).toMatchObject({ type: "error", code: "MESSAGE_NOT_FOUND" });
  });

  it("answers CHANNEL_NOT_FOUND for channels the caller can't see", async () => {
    await edit({ channelId: "ch_team" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sentEvents()).toMatchObject([
      ["conn-alice", { type: "error", code: "CHANNEL_NOT_FOUND" }],
    ]);
  });
});
