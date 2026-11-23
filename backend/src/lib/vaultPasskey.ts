import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_VAULT_PASSKEYS,
  VAULT_PASSKEY_CHALLENGE_MS,
  type VaultPasskeyChallenge,
} from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { HttpError } from "./http";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// The Vault with a fingerprint (Phase 77): WebAuthn with the device's own
// authenticator (Touch ID on a Mac, Windows Hello, a phone's biometrics). A
// device is enrolled while the Vault is open with the PIN; from then on it
// can open the Vault instead of the PIN. On the person's `users` row:
//
//   vaultPasskeys                 the enrolled devices: credential id, public
//                                 key (SPKI), algorithm, where it was enrolled
//                                 (origin, RP id), a name and a use counter;
//   vaultPasskeyChallenge         the pending challenge (one at a time), and
//   vaultPasskeyChallengeExpiresAt  when it lapses.
//
// The private key never leaves the device and the server keeps no secret: it
// checks, each time, that the device signed *this* challenge, for *this* site
// (the RP id's hash and the origin it was enrolled from), with the person
// verified (the fingerprint, not just a tap). A challenge is used once.
// ---------------------------------------------------------------------------

export interface StoredPasskey {
  id: string;
  /** SubjectPublicKeyInfo, base64url. */
  publicKey: string;
  /** COSE algorithm: -7 (ES256) or -257 (RS256). */
  alg: number;
  origin: string;
  rpId: string;
  name: string;
  createdAt: number;
  counter: number;
}

interface PasskeyRow {
  vaultPin?: string;
  vaultPasskeys?: StoredPasskey[];
  vaultPasskeyChallenge?: string;
  vaultPasskeyChallengeExpiresAt?: number;
}

const b64u = (text: string) => Buffer.from(text, "base64url");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

async function readRow(userId: string): Promise<PasskeyRow> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.users,
      Key: { userId },
      ConsistentRead: true,
      ProjectionExpression:
        "vaultPin, vaultPasskeys, vaultPasskeyChallenge, vaultPasskeyChallengeExpiresAt",
    }),
  );
  return (Item as PasskeyRow | undefined) ?? {};
}

/** The devices enrolled, without their keys (for the page). */
export async function passkeyIds(userId: string): Promise<string[]> {
  return ((await readRow(userId)).vaultPasskeys ?? []).map((p) => p.id);
}

/** `POST /vault/passkey/challenge`: a fresh challenge, and the devices that may answer it. */
export async function newChallenge(
  userId: string,
  now = Date.now(),
): Promise<VaultPasskeyChallenge> {
  const row = await readRow(userId);
  const challenge = randomBytes(32).toString("base64url");
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId },
      UpdateExpression: "SET vaultPasskeyChallenge = :c, vaultPasskeyChallengeExpiresAt = :e",
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeValues: { ":c": challenge, ":e": now + VAULT_PASSKEY_CHALLENGE_MS },
    }),
  );
  return { challenge, credentialIds: (row.vaultPasskeys ?? []).map((p) => p.id) };
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

/** The pending challenge, taken (it can't be answered twice); throws when there is none. */
async function takeChallenge(userId: string, row: PasskeyRow, now: number): Promise<string> {
  const challenge = row.vaultPasskeyChallenge;
  if (!challenge || (row.vaultPasskeyChallengeExpiresAt ?? 0) <= now) {
    throw new HttpError(400, "The fingerprint request expired. Try again.");
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression: "REMOVE vaultPasskeyChallenge, vaultPasskeyChallengeExpiresAt",
        ConditionExpression: "vaultPasskeyChallenge = :c",
        ExpressionAttributeValues: { ":c": challenge },
      }),
    );
  } catch {
    throw new HttpError(400, "The fingerprint request expired. Try again.");
  }
  return challenge;
}

function clientDataOf(json: Buffer, type: string, challenge: string): ClientData {
  let data: ClientData;
  try {
    data = JSON.parse(json.toString("utf8")) as ClientData;
  } catch {
    throw new HttpError(400, "Malformed fingerprint response");
  }
  const given = Buffer.from(String(data.challenge ?? ""));
  const wanted = Buffer.from(challenge);
  if (
    data.type !== type ||
    given.length !== wanted.length ||
    !timingSafeEqual(given, wanted) ||
    typeof data.origin !== "string" ||
    !data.origin.startsWith("https://")
  ) {
    throw new HttpError(400, "The fingerprint response doesn't match the request");
  }
  return data;
}

export interface PasskeyRegistration {
  id: string;
  publicKey: string;
  alg: number;
  clientDataJSON: string;
  name: string;
}

/**
 * `POST /vault/passkey`: enrolls this device. The caller's Vault is open with
 * their PIN (checked by the handler), so the key is theirs to add.
 */
export async function registerPasskey(
  userId: string,
  input: PasskeyRegistration,
  now = Date.now(),
): Promise<{ id: string }> {
  const row = await readRow(userId);
  if (!row.vaultPin) throw new HttpError(409, "Set your Vault PIN first");
  const challenge = await takeChallenge(userId, row, now);
  const data = clientDataOf(b64u(input.clientDataJSON), "webauthn.create", challenge);
  if (input.alg !== -7 && input.alg !== -257) {
    throw new HttpError(400, "This device's key type isn't supported");
  }
  try {
    // A key the server can verify with later, or it isn't kept.
    createPublicKey({ key: b64u(input.publicKey), format: "der", type: "spki" });
  } catch {
    throw new HttpError(400, "This device's key couldn't be read");
  }
  const passkey: StoredPasskey = {
    id: input.id,
    publicKey: input.publicKey,
    alg: input.alg,
    origin: data.origin,
    rpId: new URL(data.origin).hostname,
    name: input.name,
    createdAt: now,
    counter: 0,
  };
  const kept = (row.vaultPasskeys ?? []).filter((p) => p.id !== input.id);
  if (kept.length >= MAX_VAULT_PASSKEYS) {
    throw new HttpError(400, "Too many devices: remove one first");
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId },
      UpdateExpression: "SET vaultPasskeys = :p",
      ExpressionAttributeValues: { ":p": [...kept, passkey] },
    }),
  );
  log.info("vault passkey enrolled", { userId, devices: kept.length + 1 });
  return { id: passkey.id };
}

export interface PasskeyAssertion {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/**
 * Whether an enrolled device signed the pending challenge for this site with
 * the person verified. Throws 401 on anything else; nothing says which check
 * failed.
 */
export async function verifyPasskey(
  userId: string,
  input: PasskeyAssertion,
  now = Date.now(),
): Promise<void> {
  const row = await readRow(userId);
  const refuse = () => new HttpError(401, "The fingerprint wasn't accepted. Use your PIN.");
  const passkey = (row.vaultPasskeys ?? []).find((p) => p.id === input.id);
  if (!row.vaultPin || !passkey) throw refuse();
  const challenge = await takeChallenge(userId, row, now);
  const clientDataJSON = b64u(input.clientDataJSON);
  const authData = b64u(input.authenticatorData);
  let data: ClientData;
  try {
    data = clientDataOf(clientDataJSON, "webauthn.get", challenge);
  } catch {
    throw refuse();
  }
  // Bytes 0–31: SHA-256 of the RP id; 32: flags (0x01 present, 0x04 verified); 33–36: counter.
  if (authData.length < 37 || data.origin !== passkey.origin) throw refuse();
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32]!;
  if (!timingSafeEqual(rpIdHash, sha256(passkey.rpId)) || (flags & 0x05) !== 0x05) throw refuse();
  let valid = false;
  try {
    valid = verify(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      createPublicKey({ key: b64u(passkey.publicKey), format: "der", type: "spki" }),
      b64u(input.signature),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    log.warn("vault passkey refused", { userId });
    throw refuse();
  }
  // A counter that goes backwards is a copied key (0 means the device doesn't count).
  const counter = authData.readUInt32BE(33);
  if (counter !== 0 && counter <= passkey.counter) {
    log.warn("vault passkey counter went back", { userId });
    throw refuse();
  }
  if (counter !== passkey.counter) {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression: "SET vaultPasskeys = :p",
        ExpressionAttributeValues: {
          ":p": (row.vaultPasskeys ?? []).map((p) => (p.id === passkey.id ? { ...p, counter } : p)),
        },
      }),
    );
  }
}

/** `DELETE /vault/passkey`: every enrolled device forgotten (the PIN still opens the Vault). */
export async function removePasskeys(userId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId },
      UpdateExpression:
        "REMOVE vaultPasskeys, vaultPasskeyChallenge, vaultPasskeyChallengeExpiresAt",
      ConditionExpression: "attribute_exists(userId)",
    }),
  );
  log.info("vault passkeys removed", { userId });
}
