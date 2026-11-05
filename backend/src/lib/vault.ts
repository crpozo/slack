import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { DeleteCommand, GetCommand, paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import { VAULT_METADATA_ATTRIBUTES, type VaultSecret } from "@mindfultech/shared";
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
// The table: `secretId` (`vs_<ulid>`) is the key. Lists (Phase 46: filtered
// by who may see each secret) Scan it for `VAULT_METADATA_ATTRIBUTES` only, and the
// Lambda's IAM policy only allows a Scan that asks for exactly those, so a
// list can never read a ciphertext.
// ---------------------------------------------------------------------------

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

/** `plaintext` encrypted under the Vault key, bound to `context` (base64). */
export async function kmsEncrypt(
  plaintext: string,
  context: Record<string, string>,
): Promise<string> {
  const { CiphertextBlob } = await kmsClient().send(
    new EncryptCommand({
      KeyId: keyId(),
      Plaintext: Buffer.from(plaintext, "utf8"),
      EncryptionContext: context,
    }),
  );
  if (!CiphertextBlob?.length) throw new Error("KMS returned no ciphertext");
  return Buffer.from(CiphertextBlob).toString("base64");
}

/** A `kmsEncrypt` blob back to text; KMS checks the key and the context. */
export async function kmsDecrypt(blob: string, context: Record<string, string>): Promise<string> {
  const { Plaintext } = await kmsClient().send(
    new DecryptCommand({
      // Pinned: a ciphertext made under any other key is refused.
      KeyId: keyId(),
      CiphertextBlob: Buffer.from(blob, "base64"),
      EncryptionContext: context,
    }),
  );
  if (!Plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(Plaintext).toString("utf8");
}

/** The password, encrypted under the Vault key for `row` only. */
export const encryptPassword = (password: string, row: ContextOf): Promise<string> =>
  kmsEncrypt(password, encryptionContextOf(row));

/** The row's password, decrypted by KMS. */
export const decryptPassword = (row: VaultRow): Promise<string> =>
  kmsDecrypt(row.encryptedPassword, encryptionContextOf(row));

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
    // Rows from before Phase 46 have none: their saver and admins only.
    allowedUserIds: Array.isArray(item.allowedUserIds)
      ? item.allowedUserIds.filter((id): id is string => typeof id === "string")
      : [],
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
    ...(typeof item.updatedAt === "number" && { updatedAt: item.updatedAt }),
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

/** Replaces an existing row (an edit); a row deleted meanwhile isn't brought back. */
export async function replaceVaultRow(row: VaultRow): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tables.vault,
      Item: row,
      ConditionExpression: "attribute_exists(secretId)",
    }),
  );
}

/** Every secret's metadata (a Scan for `VAULT_METADATA_ATTRIBUTES` only), newest first. */
export async function scanSecrets(): Promise<VaultSecret[]> {
  const names = Object.fromEntries(VAULT_METADATA_ATTRIBUTES.map((a, i) => [`#a${i}`, a]));
  const secrets: VaultSecret[] = [];
  const pages = paginateScan(
    { client: ddb },
    {
      TableName: tables.vault,
      Select: "SPECIFIC_ATTRIBUTES",
      ProjectionExpression: Object.keys(names).join(", "),
      ExpressionAttributeNames: names,
    },
  );
  for await (const page of pages) secrets.push(...(page.Items ?? []).map(toVaultSecret));
  return secrets.sort(newestFirst);
}
