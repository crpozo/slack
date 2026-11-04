import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  DeleteCommand,
  GetCommand,
  paginateScan,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { VaultSecret } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { requireEnv } from "./env";

// ---------------------------------------------------------------------------
// Vault (Phase 45): the team's passwords, encrypted with a customer-managed
// KMS key before they reach DynamoDB. A row holds the metadata and
// `encryptedPassword` (the KMS ciphertext, base64), never the plaintext.
//
// Every encryption is bound to its row by the encryption context (`purpose`,
// `secretId`, `channelId`): KMS only decrypts with the same context, so a
// ciphertext copied into another row, or under another channel, doesn't
// decrypt; the Lambda's IAM policy also only allows `purpose: vault`. KMS
// logs each Encrypt and Decrypt in CloudTrail, context included.
//
// The table: `secretId` (`vs_<ulid>`) is the key; the `byChannel` index
// (`channelId` + `createdAt`) projects the metadata only, so listing never
// reads a ciphertext at all.
// ---------------------------------------------------------------------------

export const VAULT_BY_CHANNEL_INDEX = "byChannel";
export const SECRET_ID = /^vs_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A `vault` row. */
export interface VaultRow extends VaultSecret {
  /** KMS ciphertext of the password, base64. */
  encryptedPassword: string;
}

type ContextOf = Pick<VaultRow, "secretId" | "channelId">;
export const encryptionContextOf = (row: ContextOf): Record<string, string> => ({
  purpose: "vault",
  secretId: row.secretId,
  channelId: row.channelId,
});

let kms: KMSClient | undefined;
const kmsClient = () => (kms ??= new KMSClient({}));
const keyId = () => requireEnv("VAULT_KEY_ID");

/** The password, encrypted under the Vault key for `row` only. */
export async function encryptPassword(password: string, row: ContextOf): Promise<string> {
  const { CiphertextBlob } = await kmsClient().send(
    new EncryptCommand({
      KeyId: keyId(),
      Plaintext: Buffer.from(password, "utf8"),
      EncryptionContext: encryptionContextOf(row),
    }),
  );
  if (!CiphertextBlob?.length) throw new Error("KMS returned no ciphertext");
  return Buffer.from(CiphertextBlob).toString("base64");
}

/** The row's password, decrypted by KMS (which checks the key and the context). */
export async function decryptPassword(row: VaultRow): Promise<string> {
  const { Plaintext } = await kmsClient().send(
    new DecryptCommand({
      // Pinned: a ciphertext made under any other key is refused.
      KeyId: keyId(),
      CiphertextBlob: Buffer.from(row.encryptedPassword, "base64"),
      EncryptionContext: encryptionContextOf(row),
    }),
  );
  if (!Plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(Plaintext).toString("utf8");
}

/** What clients get: the metadata, field by field (a ciphertext can't slip through). */
export function toVaultSecret(item: Record<string, unknown>): VaultSecret {
  const text = (key: string) =>
    typeof item[key] === "string" && item[key] ? item[key] : undefined;
  return {
    secretId: String(item.secretId),
    channelId: String(item.channelId),
    name: String(item.name ?? ""),
    ...(text("username") && { username: text("username") }),
    ...(text("website") && { website: text("website") }),
    createdBy: String(item.createdBy ?? ""),
    ...(text("createdByName") && { createdByName: text("createdByName") }),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
  };
}

const newestFirst = (a: VaultSecret, b: VaultSecret) =>
  b.createdAt - a.createdAt || b.secretId.localeCompare(a.secretId);

export async function putVaultRow(row: VaultRow): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tables.vault,
      Item: row,
      ConditionExpression: "attribute_not_exists(secretId)",
    }),
  );
}

export async function getVaultRow(secretId: string): Promise<VaultRow | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.vault, Key: { secretId }, ConsistentRead: true }),
  );
  return (Item as VaultRow | undefined) ?? null;
}

export async function deleteVaultRow(secretId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: tables.vault, Key: { secretId } }));
}

/** One channel's secrets (metadata only, from the index), newest first. */
export async function listChannelSecrets(channelId: string): Promise<VaultSecret[]> {
  const secrets: VaultSecret[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tables.vault,
        IndexName: VAULT_BY_CHANNEL_INDEX,
        KeyConditionExpression: "channelId = :c",
        ExpressionAttributeValues: { ":c": channelId },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }),
    );
    secrets.push(...(page.Items ?? []).map(toVaultSecret));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return secrets.sort(newestFirst);
}

/** The secrets of the given channels (a Scan of the metadata index: small at this scale). */
export async function listSecretsIn(channelIds: Set<string>): Promise<VaultSecret[]> {
  const secrets: VaultSecret[] = [];
  const pages = paginateScan(
    { client: ddb },
    { TableName: tables.vault, IndexName: VAULT_BY_CHANNEL_INDEX },
  );
  for await (const page of pages) {
    for (const item of page.Items ?? []) {
      if (channelIds.has(String(item.channelId))) secrets.push(toVaultSecret(item));
    }
  }
  return secrets.sort(newestFirst);
}
