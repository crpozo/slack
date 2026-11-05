import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  VAULT_PIN_MAX_ATTEMPTS,
  VAULT_SESSION_MS,
  vaultLockMs,
  type VaultPinRefusal,
  type VaultPinStatus,
  type VaultUnlock,
} from "@mindfultech/shared";
import bcrypt from "bcryptjs";
import { ddb, tables } from "./ddb";
import { HttpError } from "./http";
import { log } from "./logger";
import { kmsDecrypt, kmsEncrypt } from "./vault";

// ---------------------------------------------------------------------------
// The Vault PIN (Phase 46), on the person's `users` row:
//
//   vaultPin               bcrypt hash of the PIN (cost 12), itself encrypted
//                          with the Vault's KMS key (context `vault-pin` + the
//                          user): a 4-digit PIN has only 10,000 values, so a
//                          copy of the table alone must not be enough to try
//                          them all offline.
//   vaultPinFailures       wrong PINs in a row (reserved before each check);
//   vaultPinLockouts       lockouts so far (each one twice as long);
//   vaultPinLockedUntil    epoch ms while locked;
//   vaultSessionHash       SHA-256 of the open Vault's session token, and
//   vaultSessionExpiresAt  when it closes (one session per person).
//
// Every other writer of `users` updates its own attributes (never a Put of
// the whole row), and every reader that answers clients picks its fields
// (`toUserProfile`), so none of these leave the server.
//
// Brute force: an attempt is *reserved* (the counter goes up, conditionally)
// before the PIN is compared, so even requests sent all at once get at most
// `VAULT_PIN_MAX_ATTEMPTS` comparisons before the lock.
// ---------------------------------------------------------------------------

const BCRYPT_COST = 12;

interface PinRow {
  vaultPin?: string;
  vaultPinFailures?: number;
  vaultPinLockouts?: number;
  vaultPinLockedUntil?: number;
  vaultSessionHash?: string;
  vaultSessionExpiresAt?: number;
}

const pinContext = (userId: string) => ({ purpose: "vault-pin", userId });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Tests: a cheaper bcrypt cost. */
let cost = BCRYPT_COST;
export function useBcryptCost(next: number | null): void {
  cost = next ?? BCRYPT_COST;
}

async function readPinRow(userId: string): Promise<PinRow> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.users,
      Key: { userId },
      ConsistentRead: true,
      ProjectionExpression:
        "vaultPin, vaultPinFailures, vaultPinLockouts, vaultPinLockedUntil, vaultSessionHash, vaultSessionExpiresAt",
    }),
  );
  return (Item as PinRow | undefined) ?? {};
}

const failuresOf = (row: PinRow) => row.vaultPinFailures ?? 0;
const lockedNow = (row: PinRow, now: number) => (row.vaultPinLockedUntil ?? 0) > now;

export async function pinStatus(userId: string, now = Date.now()): Promise<VaultPinStatus> {
  const row = await readPinRow(userId);
  const locked = lockedNow(row, now);
  return {
    hasPin: !!row.vaultPin,
    ...(locked && { lockedUntil: row.vaultPinLockedUntil }),
    // A lock that ran out gives a fresh set of attempts.
    attemptsLeft: locked
      ? 0
      : row.vaultPinLockedUntil
        ? VAULT_PIN_MAX_ATTEMPTS
        : Math.max(0, VAULT_PIN_MAX_ATTEMPTS - failuresOf(row)),
  };
}

/** A new session token, stored hashed; it opens the Vault until `expiresAt`. */
async function openSession(userId: string, now: number): Promise<VaultUnlock> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + VAULT_SESSION_MS;
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId },
      UpdateExpression: "SET vaultSessionHash = :h, vaultSessionExpiresAt = :e",
      ExpressionAttributeValues: { ":h": sha256(token), ":e": expiresAt },
    }),
  );
  return { token, expiresAt };
}

/** `POST /vault/pin`: the first PIN only (a second one would bypass the lockout). */
export async function setPin(userId: string, pin: string, now = Date.now()): Promise<VaultUnlock> {
  if ((await readPinRow(userId)).vaultPin) throw new HttpError(409, "You already have a Vault PIN");
  const hash = await bcrypt.hash(pin, cost);
  const wrapped = await kmsEncrypt(hash, pinContext(userId));
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression:
          "SET vaultPin = :pin, vaultPinFailures = :zero, vaultPinLockouts = :zero, vaultPinSetAt = :now REMOVE vaultPinLockedUntil",
        // The row exists (every signed-in person has one) and has no PIN yet.
        ConditionExpression: "attribute_exists(userId) AND attribute_not_exists(vaultPin)",
        ExpressionAttributeValues: { ":pin": wrapped, ":zero": 0, ":now": now },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(409, "You already have a Vault PIN");
    }
    throw err;
  }
  log.info("vault pin set", { userId });
  return openSession(userId, now);
}

export type PinCheck = { ok: true } | { ok: false; status: 401 | 409 | 423; body: PinRefusal };
type PinRefusal = VaultPinRefusal & { message: string };

const locked = (until: number): PinCheck => ({
  ok: false,
  status: 423,
  body: {
    code: "PIN_LOCKED",
    lockedUntil: until,
    attemptsLeft: 0,
    message: "Too many wrong PINs. The Vault is locked for now.",
  },
});

/**
 * Checks `pin` against the caller's, with the brute-force limits: an attempt
 * is reserved first; the fifth wrong one in a row locks the PIN for
 * `vaultLockMs(lockouts)`. A right one clears the count.
 */
export async function checkPin(userId: string, pin: string, now = Date.now()): Promise<PinCheck> {
  const row = await readPinRow(userId);
  if (!row.vaultPin) {
    return {
      ok: false,
      status: 409,
      body: { code: "PIN_NOT_SET", message: "Open the Vault to set your PIN first" },
    };
  }
  if (lockedNow(row, now)) return locked(row.vaultPinLockedUntil!);
  if (row.vaultPinLockedUntil) {
    // The lock ran out: a fresh set of attempts (once, if two requests race).
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tables.users,
          Key: { userId },
          UpdateExpression: "SET vaultPinFailures = :zero REMOVE vaultPinLockedUntil",
          ConditionExpression: "vaultPinLockedUntil = :seen",
          ExpressionAttributeValues: { ":zero": 0, ":seen": row.vaultPinLockedUntil },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  let attempt: number;
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression: "SET vaultPinFailures = if_not_exists(vaultPinFailures, :zero) + :one",
        ConditionExpression:
          "attribute_exists(vaultPin) AND " +
          "(attribute_not_exists(vaultPinFailures) OR vaultPinFailures < :max) AND " +
          "(attribute_not_exists(vaultPinLockedUntil) OR vaultPinLockedUntil <= :now)",
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":max": VAULT_PIN_MAX_ATTEMPTS,
          ":now": now,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    attempt = Number(Attributes?.vaultPinFailures ?? VAULT_PIN_MAX_ATTEMPTS);
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Out of attempts: another request just used the last one (and is locking it).
    const latest = await readPinRow(userId);
    return locked(latest.vaultPinLockedUntil ?? now + vaultLockMs(latest.vaultPinLockouts ?? 0));
  }

  const hash = await kmsDecrypt(row.vaultPin, pinContext(userId));
  if (await bcrypt.compare(pin, hash)) {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression:
          "SET vaultPinFailures = :zero, vaultPinLockouts = :zero REMOVE vaultPinLockedUntil",
        ExpressionAttributeValues: { ":zero": 0 },
      }),
    );
    return { ok: true };
  }

  if (attempt >= VAULT_PIN_MAX_ATTEMPTS) {
    const until = now + vaultLockMs(row.vaultPinLockouts ?? 0);
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression:
          "SET vaultPinLockedUntil = :until, vaultPinLockouts = if_not_exists(vaultPinLockouts, :zero) + :one",
        ExpressionAttributeValues: { ":until": until, ":zero": 0, ":one": 1 },
      }),
    );
    log.warn("vault pin locked", { userId, until, lockouts: (row.vaultPinLockouts ?? 0) + 1 });
    return locked(until);
  }
  log.warn("vault pin wrong", { userId, attempt });
  const attemptsLeft = VAULT_PIN_MAX_ATTEMPTS - attempt;
  return {
    ok: false,
    status: 401,
    body: {
      code: "PIN_WRONG",
      attemptsLeft,
      message: `Wrong PIN. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left before the Vault locks.`,
    },
  };
}

/** `POST /vault/pin/verify`: a right PIN opens the Vault for `VAULT_SESSION_MS`. */
export async function unlock(
  userId: string,
  pin: string,
  now = Date.now(),
): Promise<{ ok: true; unlock: VaultUnlock } | Extract<PinCheck, { ok: false }>> {
  const check = await checkPin(userId, pin, now);
  if (!check.ok) return check;
  return { ok: true, unlock: await openSession(userId, now) };
}

/** Whether `token` is the caller's open Vault session. */
export async function sessionIsOpen(
  userId: string,
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const row = await readPinRow(userId);
  if (!row.vaultSessionHash || (row.vaultSessionExpiresAt ?? 0) <= now) return false;
  const given = Buffer.from(sha256(token), "hex");
  const stored = Buffer.from(row.vaultSessionHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** An admin's reset (a forgotten PIN): the person sets a new one on their next visit. */
export async function resetPin(userId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId },
      UpdateExpression:
        "REMOVE vaultPin, vaultPinFailures, vaultPinLockouts, vaultPinLockedUntil, vaultPinSetAt, vaultSessionHash, vaultSessionExpiresAt",
      ConditionExpression: "attribute_exists(userId)",
    }),
  );
}
