import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillImages, imageAtOfRow } from "../scripts/backfill/images";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const mock = mockClient(ddb);
const TABLE = "slack-dev-messages";
const png = { key: "attachments/ch/a.png", name: "a.png", contentType: "image/png", size: 1 };
const pdf = { key: "attachments/ch/a.pdf", name: "a.pdf", contentType: "application/pdf", size: 1 };
const message = (i: number, extra: Record<string, unknown> = {}) => ({
  channelId: "ch",
  sk: `170000000000${i}#M${i}`,
  messageId: `M${i}`,
  createdAt: 1700000000000 + i,
  attachments: [png],
  ...extra,
});

beforeEach(() => {
  mock.reset();
  mock.on(UpdateCommand).resolves({});
});

describe("backfill-images (Phase 61)", () => {
  it("gives imageAt to what the app would: images only, never secrets, cards or deleted ones", () => {
    expect(imageAtOfRow(message(1))).toBe("1700000000001#M1");
    expect(imageAtOfRow(message(2, { attachments: [pdf] }))).toBeUndefined();
    expect(imageAtOfRow(message(3, { isSecret: true }))).toBeUndefined();
    expect(imageAtOfRow(message(4, { kind: "meeting" }))).toBeUndefined();
    expect(imageAtOfRow(message(5, { deletedAt: 1 }))).toBeUndefined();
    expect(imageAtOfRow({ channelId: "x" })).toBeUndefined();
  });

  it("a dry run scans (attachments, no imageAt yet) and writes nothing", async () => {
    mock
      .on(ScanCommand)
      .resolvesOnce({ Items: [message(1)], LastEvaluatedKey: { channelId: "ch", sk: "x" } })
      .resolves({ Items: [message(2, { attachments: [pdf] }), message(3)] });
    const report = await backfillImages(ddb, TABLE, { apply: false });
    expect(report).toEqual({ scanned: 3, images: 2, skipped: 0 });
    expect(mock.commandCalls(ScanCommand)[0]!.args[0].input).toMatchObject({
      TableName: TABLE,
      FilterExpression: "size(#attachments) > :zero AND attribute_not_exists(#imageAt)",
    });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("--apply sets imageAt only on messages still there and not deleted", async () => {
    mock.on(ScanCommand).resolves({ Items: [message(1), message(2)] });
    mock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejects(new ConditionalCheckFailedException({ message: "gone", $metadata: {} }));
    const report = await backfillImages(ddb, TABLE, { apply: true });
    expect(report).toEqual({ scanned: 2, images: 1, skipped: 1 });
    expect(mock.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { channelId: "ch", sk: "1700000000001#M1" },
      UpdateExpression: "SET #imageAt = :at",
      ExpressionAttributeValues: { ":at": "1700000000001#M1", ":id": "M1" },
    });
  });
});
