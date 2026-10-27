import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { secretTtlFor, shortenSecretTtl } from "../scripts/backfill/secrets";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const mock = mockClient(ddb);
const TABLE = "slack-dev-messages";
const NOW = 1_770_000_000_000;
const HOUR = 3_600_000;
const weekLong = (sentAt: number) => Math.floor((sentAt + 7 * 24 * HOUR) / 1000);
const secret = (i: number, sentAt: number, expiresAt = weekLong(sentAt)) => ({
  channelId: "dm_a_b",
  sk: `${sentAt}#S${i}`,
  createdAt: sentAt,
  expiresAt,
});

beforeEach(() => {
  mock.reset();
  mock.on(UpdateCommand).resolves({});
});

describe("shorten-secret-ttl", () => {
  it("reads only secrets, and in a dry run counts what it would shorten without writing", async () => {
    mock.on(ScanCommand).resolves({
      Items: [
        secret(1, NOW - HOUR), // sent an hour ago: TTL down to 23 hours from now
        secret(2, NOW - 30 * HOUR), // already past 24 hours: overdue
        secret(3, NOW - HOUR, secretTtlFor(NOW - HOUR)), // already on the new TTL
      ],
    });
    const report = await shortenSecretTtl(ddb, TABLE, { apply: false, now: NOW });
    expect(report).toEqual({ secrets: 3, shortened: 2, overdue: 1 });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(mock.commandCalls(ScanCommand)[0]!.args[0].input).toMatchObject({
      TableName: TABLE,
      FilterExpression: "attribute_exists(isSecret) AND attribute_exists(expiresAt)",
    });
  });

  it("sets each TTL to 24 hours after the secret was sent, only if it's still the one read", async () => {
    const sentAt = NOW - HOUR;
    mock.on(ScanCommand).resolves({ Items: [secret(1, sentAt)] });
    await shortenSecretTtl(ddb, TABLE, { apply: true, now: NOW });
    expect(mock.commandCalls(UpdateCommand)[0]!.args[0].input).toEqual({
      TableName: TABLE,
      Key: { channelId: "dm_a_b", sk: `${sentAt}#S1` },
      UpdateExpression: "SET expiresAt = :ttl",
      ConditionExpression: "expiresAt = :read",
      ExpressionAttributeValues: {
        ":ttl": Math.floor((sentAt + 24 * HOUR) / 1000),
        ":read": weekLong(sentAt),
      },
    });
  });

  it("skips a secret deleted or changed since the scan", async () => {
    mock.on(ScanCommand).resolves({ Items: [secret(1, NOW - HOUR), secret(2, NOW - 2 * HOUR)] });
    mock
      .on(UpdateCommand)
      .rejectsOnce(new ConditionalCheckFailedException({ message: "gone", $metadata: {} }))
      .resolves({});
    const report = await shortenSecretTtl(ddb, TABLE, { apply: true, now: NOW });
    expect(report.shortened).toBe(2);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(2);
  });
});
