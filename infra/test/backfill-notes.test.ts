import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillNotes, pointersOf } from "../scripts/backfill/notes";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const mock = mockClient(ddb);
const tables = { messages: "slack-dev-messages", meetingNotes: "slack-dev-meeting-notes" };
const card = (i: number) => ({
  channelId: "dm_a_b",
  sk: `${i}#m${i}`,
  aiNotes: { callId: `c${i}`, endedAt: i, participants: ["a", "b"] },
});

beforeEach(() => {
  mock.reset();
  mock.on(BatchWriteCommand).resolves({});
});

describe("backfill-notes", () => {
  it("one pointer per participant, exactly as POST /calls/summary writes them", () => {
    expect(pointersOf(card(1))).toEqual([
      { userId: "a", sk: "1#m1", channelId: "dm_a_b", callId: "c1", endedAt: 1 },
      { userId: "b", sk: "1#m1", channelId: "dm_a_b", callId: "c1", endedAt: 1 },
    ]);
    expect(pointersOf({ channelId: "x" })).toEqual([]);
  });

  it("scans only notes cards across pages; a dry run writes nothing", async () => {
    mock
      .on(ScanCommand)
      .resolvesOnce({ Items: [card(1)], LastEvaluatedKey: { channelId: "dm_a_b", sk: "1#m1" } })
      .resolves({ Items: [card(2)] });
    const report = await backfillNotes(ddb, tables, { apply: false });
    expect(report).toEqual({ cards: 2, pointers: 4 });
    expect(mock.commandCalls(ScanCommand)[0]!.args[0].input).toMatchObject({
      TableName: "slack-dev-messages",
      FilterExpression: "kind = :kind",
      ExpressionAttributeValues: { ":kind": "ai_notes" },
    });
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it("writes in batches of 25 and re-sends what was left unprocessed", async () => {
    mock.on(ScanCommand).resolves({ Items: Array.from({ length: 13 }, (_, i) => card(i)) });
    const leftover = { PutRequest: { Item: pointersOf(card(0))[0] } };
    mock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { [tables.meetingNotes]: [leftover] } })
      .resolves({});
    const report = await backfillNotes(ddb, tables, { apply: true });
    expect(report.pointers).toBe(26);
    const sizes = mock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems![tables.meetingNotes]!.length);
    expect(sizes).toEqual([25, 1, 1]); // 25, its leftover, then the 26th
  });
});
