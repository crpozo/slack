import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillSearch, searchRowsOf } from "../scripts/backfill/search";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const mock = mockClient(ddb);
const tables = { messages: "slack-dev-messages", messageSearch: "slack-dev-message-search" };
const message = (i: number, text: string, extra: Record<string, unknown> = {}) => ({
  channelId: "ch_proj",
  sk: `170000000000${i}#M${i}`,
  messageId: `M${i}`,
  userId: "ana",
  createdAt: 1700000000000 + i,
  text,
  attachments: [],
  ...extra,
});

beforeEach(() => {
  mock.reset();
  mock.on(BatchWriteCommand).resolves({});
});

describe("backfill-search", () => {
  it("writes one row per term, as the stream processor does; nothing for secrets or deletions", () => {
    expect(searchRowsOf(message(1, "Release notes for v2"))).toEqual([
      { channelId: "ch_proj", sk: "release#1700000000001#M1" },
      { channelId: "ch_proj", sk: "notes#1700000000001#M1" },
      { channelId: "ch_proj", sk: "v2#1700000000001#M1" },
    ]);
    expect(searchRowsOf(message(2, "hunter22", { isSecret: true }))).toEqual([]);
    expect(searchRowsOf(message(3, "", { deletedAt: 1 }))).toEqual([]);
    expect(searchRowsOf({ channelId: "ch_proj", sk: "meta" })).toEqual([]);
  });

  it("counts in a dry run, writes 25 rows a batch with --apply", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    mock
      .on(ScanCommand)
      .resolves({ Items: [message(1, long), message(2, "only secret", { isSecret: true })] });
    expect(await backfillSearch(ddb, tables, { apply: false })).toEqual({ messages: 1, rows: 30 });
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    await backfillSearch(ddb, tables, { apply: true });
    const sizes = mock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems![tables.messageSearch]!.length);
    expect(sizes).toEqual([25, 5]);
  });
});
