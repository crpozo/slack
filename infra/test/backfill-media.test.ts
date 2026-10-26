import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillMedia, rowsOf } from "../scripts/backfill/media";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const mock = mockClient(ddb);
const tables = { messages: "slack-dev-messages", channelMedia: "slack-dev-channel-media" };
const message = (i: number, extra: Record<string, unknown> = {}) => ({
  channelId: "ch_proj",
  sk: `170000000000${i}#M${i}`,
  messageId: `M${i}`,
  userId: "ana",
  createdAt: 1700000000000 + i,
  text: "",
  attachments: [],
  ...extra,
});
const file = {
  key: "attachments/ch_proj/a.pdf",
  name: "a.pdf",
  contentType: "application/pdf",
  size: 10,
};

beforeEach(() => {
  mock.reset();
  mock.on(BatchWriteCommand).resolves({});
});

describe("backfill-media", () => {
  it("writes the rows the app writes: files, links (thread replies too), never secrets or cards", () => {
    expect(rowsOf(message(1, { attachments: [file], text: "spec https://x.ec/spec" }))).toEqual([
      expect.objectContaining({ sk: "file#1700000000001#M1#00", kind: "file", attachment: file }),
      expect.objectContaining({
        sk: "link#1700000000001#M1#00",
        kind: "link",
        url: "https://x.ec/spec",
        domain: "x.ec",
      }),
    ]);
    const reply = rowsOf(
      message(2, {
        text: "https://y.ec",
        parentSk: "1700000000001#M1",
        sk: "thread#1700000000001#M1#1700000000002#M2",
      }),
    );
    expect(reply[0]).toMatchObject({
      sk: "link#1700000000002#M2#00",
      parentSk: "1700000000001#M1",
      messageSk: "thread#1700000000001#M1#1700000000002#M2",
    });
    expect(rowsOf(message(3, { text: "https://z.ec", isSecret: true }))).toEqual([]);
    expect(rowsOf(message(4, { text: "https://z.ec", kind: "meeting" }))).toEqual([]);
    expect(rowsOf(message(5, { text: "", deletedAt: 1 }))).toEqual([]);
    expect(rowsOf({ channelId: "x" })).toEqual([]);
  });

  it("scans across pages; a dry run counts and writes nothing", async () => {
    mock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [message(1, { attachments: [file, file] })],
        LastEvaluatedKey: { channelId: "ch_proj", sk: "x" },
      })
      .resolves({
        Items: [
          message(2, { text: "a https://a.ec b https://b.ec" }),
          message(3, { text: "no link" }),
        ],
      });
    const report = await backfillMedia(ddb, tables, { apply: false });
    expect(report).toEqual({ messages: 2, files: 2, links: 2, pins: 0 });
    expect(mock.commandCalls(ScanCommand)[0]!.args[0].input).toMatchObject({
      TableName: "slack-dev-messages",
      ExpressionAttributeValues: { ":zero": 0, ":http": "http" },
    });
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it("--apply writes in batches of 25 and retries what DynamoDB left unprocessed", async () => {
    const many = Array.from({ length: 30 }, (_, i) => message(i, { text: `https://s${i}.ec` }));
    mock.on(ScanCommand).resolves({ Items: many });
    mock
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          [tables.channelMedia]: [{ PutRequest: { Item: { channelId: "x", sk: "y" } } }],
        },
      })
      .resolves({});
    const report = await backfillMedia(ddb, tables, { apply: true });
    expect(report.links).toBe(30);
    const sizes = mock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems?.[tables.channelMedia]?.length);
    expect(sizes).toEqual([25, 1, 5]);
  });
});
