import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { paginateScan, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SECRET_TTL_MS } from "@mindfultech/shared";

export interface SecretTtlReport {
  /** Secret messages read. */
  secrets: number;
  /** Secrets whose TTL is later than 24 hours after they were sent (shortened with `apply`). */
  shortened: number;
  /** Of those, how many are already past 24 hours (DynamoDB deletes them within a few days). */
  overdue: number;
}

/** The TTL (epoch seconds) a secret sent at `createdAt` has now: 24 hours later. */
export const secretTtlFor = (createdAt: number) => Math.floor((createdAt + SECRET_TTL_MS) / 1000);

/**
 * Secrets sent while the TTL was a week keep their week-long `expiresAt`. The
 * app hides them after 24 hours anyway (`secretExpiresAt`), but their rows
 * would stay in DynamoDB until then. This brings each one's TTL down to 24
 * hours after it was sent, so DynamoDB deletes it on the new schedule (one
 * already past it is deleted within a few days, as DynamoDB sweeps). Only a
 * TTL that's still the one read is changed; nothing else is touched.
 */
export async function shortenSecretTtl(
  ddb: DynamoDBDocumentClient,
  table: string,
  { apply, now = Date.now() }: { apply: boolean; now?: number },
): Promise<SecretTtlReport> {
  const report: SecretTtlReport = { secrets: 0, shortened: 0, overdue: 0 };
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: table,
      FilterExpression: "attribute_exists(isSecret) AND attribute_exists(expiresAt)",
      ProjectionExpression: "channelId, sk, createdAt, expiresAt",
    },
  )) {
    for (const item of page.Items ?? []) {
      const { channelId, sk, createdAt, expiresAt } = item;
      if (
        typeof channelId !== "string" ||
        typeof sk !== "string" ||
        typeof createdAt !== "number" ||
        typeof expiresAt !== "number"
      ) {
        continue;
      }
      report.secrets++;
      const ttl = secretTtlFor(createdAt);
      if (expiresAt <= ttl) continue;
      report.shortened++;
      if (ttl * 1000 <= now) report.overdue++;
      if (!apply) continue;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { channelId, sk },
            UpdateExpression: "SET expiresAt = :ttl",
            ConditionExpression: "expiresAt = :read",
            ExpressionAttributeValues: { ":ttl": ttl, ":read": expiresAt },
          }),
        );
      } catch (err) {
        // Deleted or changed since the scan: nothing to shorten.
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    }
  }
  return report;
}
