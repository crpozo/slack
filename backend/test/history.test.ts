import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId, GENERAL_CHANNEL_ID, type HistoryPageEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, handler } from "../src/handlers/history";
import { ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

const msg = (n: number) => ({
  channelId: GENERAL_CHANNEL_ID,
  sk: `${1_700_000_000_000 + n}#X`,
  text: `m${n}`,
});

describe("history", () => {
  beforeEach(resetMocks);

  it("returns the newest page in ascending order with a nextCursor", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [msg(3), msg(2)],
      LastEvaluatedKey: { channelId: GENERAL_CHANNEL_ID, sk: msg(2).sk },
    });

    const result = await handler(
      wsEvent("history", { action: "history", channelId: GENERAL_CHANNEL_ID }),
    );

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toEqual({
      TableName: "slack-test-messages",
      KeyConditionExpression: "channelId = :c",
      ExpressionAttributeValues: { ":c": GENERAL_CHANNEL_ID },
      ScanIndexForward: false,
      Limit: 50,
      ExclusiveStartKey: undefined,
    });
    const [[connectionId, event]] = sentEvents() as [[string, HistoryPageEvent]];
    expect(connectionId).toBe("conn-alice");
    expect(event.type).toBe("history.page");
    expect(event.items.map((m) => m.text)).toEqual(["m2", "m3"]);
    expect(event.nextCursor).toBe(encodeCursor({ channelId: GENERAL_CHANNEL_ID, sk: msg(2).sk }));
  });

  it("pages backwards from the cursor and ends with nextCursor null", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [msg(1)] });
    const cursor = encodeCursor({ channelId: GENERAL_CHANNEL_ID, sk: msg(2).sk });

    await handler(wsEvent("history", { action: "history", channelId: GENERAL_CHANNEL_ID, cursor }));

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ExclusiveStartKey).toEqual({
      channelId: GENERAL_CHANNEL_ID,
      sk: msg(2).sk,
    });
    const [[, event]] = sentEvents() as [[string, HistoryPageEvent]];
    expect(event.nextCursor).toBeNull();
  });

  it("rejects a cursor from another channel or garbage", async () => {
    const foreign = encodeCursor({ channelId: "ch_other", sk: "1#X" });
    expect(decodeCursor(foreign, GENERAL_CHANNEL_ID)).toBeNull();
    expect(decodeCursor("%%%garbage", GENERAL_CHANNEL_ID)).toBeNull();

    const result = await handler(
      wsEvent("history", { action: "history", channelId: GENERAL_CHANNEL_ID, cursor: foreign }),
    );
    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects an invalid payload", async () => {
    const result = await handler(wsEvent("history", { action: "history" }));
    expect(result.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  });

  it("hides DMs the caller is not part of", async () => {
    const result = await handler(
      wsEvent("history", { action: "history", channelId: dmChannelId("user-x", "user-y") }),
    );
    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "error", code: "CHANNEL_NOT_FOUND" });
  });
});
