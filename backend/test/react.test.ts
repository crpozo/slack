import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { MessageReactionEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/react";
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
const react = (body: object, user = ALICE) =>
  handler(
    wsEvent(
      "react",
      { action: "react", channelId: "ch_general", sk: SK, emoji: "👍", op: "add", ...body },
      { user, connectionId: user === ALICE ? "conn-alice" : "conn-bob" },
    ),
  );

describe("react", () => {
  beforeEach(() => {
    resetMocks();
    mockChannels(GENERAL, privateRow("ch_team", ALICE.userId, [ALICE.userId]));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
  });

  it("adds the caller to the emoji's set atomically and broadcasts the new reactions", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        messageId: "m1",
        reactions: { "👍": new Set([BOB.userId, ALICE.userId]), "🎉": new Set([BOB.userId]) },
      },
    });

    const result = await react({});

    expect(result.statusCode).toBe(200);
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ channelId: "ch_general", sk: SK });
    expect(input?.UpdateExpression).toBe("ADD #reactions.#emoji :user");
    expect(input?.ExpressionAttributeNames).toEqual({ "#reactions": "reactions", "#emoji": "👍" });
    expect(input?.ExpressionAttributeValues?.[":user"]).toEqual(new Set([ALICE.userId]));

    const sent = sentEvents() as Array<[string, MessageReactionEvent]>;
    expect(sent.map(([id]) => id).sort()).toEqual(["conn-alice", "conn-bob"]);
    expect(sent[0]?.[1]).toEqual({
      type: "message.reaction",
      channelId: "ch_general",
      sk: SK,
      messageId: "m1",
      reactions: { "👍": [ALICE.userId, BOB.userId].sort(), "🎉": [BOB.userId] },
    });
  });

  it("removes with DELETE", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { messageId: "m1", reactions: {} } });

    await react({ op: "remove" });

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression).toBe(
      "DELETE #reactions.#emoji :user",
    );
    expect((sentEvents()[0]?.[1] as MessageReactionEvent).reactions).toEqual({});
  });

  it("initializes the reactions map on messages stored before reactions existed", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejectsOnce(conditionFailed())
      .resolves({ Attributes: { messageId: "m1", reactions: { "👍": new Set([ALICE.userId]) } } });

    const result = await react({});

    expect(result.statusCode).toBe(200);
    const calls = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.UpdateExpression).toBe("SET #reactions = :reactions");
    expect(calls[1]?.ConditionExpression).toContain("attribute_not_exists(#reactions)");
    expect(calls[1]?.ExpressionAttributeValues?.[":reactions"]).toEqual({
      "👍": new Set([ALICE.userId]),
    });
  });

  it("answers MESSAGE_NOT_FOUND when the message does not exist", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    const result = await react({});

    expect(result.statusCode).toBe(400);
    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "MESSAGE_NOT_FOUND" })],
    ]);
  });

  it("treats removing from a message without reactions as a no-op", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand, { TableName: "slack-test-messages" }).resolves({
      Item: { messageId: "m1", sk: SK },
    });

    const result = await react({ op: "remove" });

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect((sentEvents()[0]?.[1] as MessageReactionEvent).reactions).toEqual({});
  });

  it("hides private channels from non-members and only notifies members", async () => {
    const denied = await react({ channelId: "ch_team" }, BOB);
    expect(denied.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "CHANNEL_NOT_FOUND" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);

    resetMocks();
    mockChannels(privateRow("ch_team", ALICE.userId, [ALICE.userId]));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { messageId: "m1", reactions: {} } });
    await react({ channelId: "ch_team" });
    expect(sentEvents().map(([id]) => id)).toEqual(["conn-alice"]);
  });

  it("rejects invalid emojis", async () => {
    for (const emoji of ["", " ", "a b", "x".repeat(17)]) {
      const result = await react({ emoji });
      expect(result.statusCode, JSON.stringify(emoji)).toBe(400);
    }
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
