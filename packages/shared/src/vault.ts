import { z } from "zod";
import type { Role } from "./roles";

// ---------------------------------------------------------------------------
// Vault (Phase 45): the team's passwords and API keys, each filed under a
// channel (the project it belongs to). The server encrypts the password with
// AWS KMS before it's stored, lists only the metadata, and decrypts one
// password at a time (`POST /vault/reveal/{secretId}`).
// `/secret <title> <password>` in a channel saves one and posts a card.
//
// Phase 46, access: admins see every secret; anyone else only the ones they
// saved or are listed in (`allowedUserIds`). Everyone has a 4-digit Vault PIN
// (bcrypt on the server, 5 tries before a lockout): it opens the Vault for a
// few minutes, and every reveal or copy asks for it again.
// ---------------------------------------------------------------------------

export const MAX_VAULT_NAME = 100;
export const MAX_VAULT_USERNAME = 200;
export const MAX_VAULT_WEBSITE = 500;
/** KMS encrypts at most 4 KB at a time; 1,024 characters are at most 4 KB of UTF-8. */
export const MAX_VAULT_PASSWORD = 1024;
/** People a secret can be shared with, besides whoever saved it. */
export const MAX_VAULT_ALLOWED = 200;

/** A secret as listed (`GET /vault`, `GET /vault/{channelId}`): never its password. */
export interface VaultSecret {
  secretId: string;
  /** The channel (project) it belongs to: its members may reveal it. */
  channelId: string;
  name: string;
  username?: string;
  /** An `http(s)` URL (`normalizeWebsite`). */
  website?: string;
  createdBy: string;
  createdByName?: string;
  /** Who else may see and reveal it (Phase 46); its saver and admins always may. */
  allowedUserIds: string[];
  /** Epoch ms. */
  createdAt: number;
  updatedAt?: number;
}

/**
 * A secret's attributes but its ciphertext: all a list may read. The vault
 * Lambda's IAM policy allows a Scan of the Vault for exactly these.
 */
export const VAULT_METADATA_ATTRIBUTES = [
  "secretId",
  "channelId",
  "name",
  "username",
  "website",
  "createdBy",
  "createdByName",
  "allowedUserIds",
  "createdAt",
  "updatedAt",
] as const;

/** The Vault PIN's attributes on a `users` row: all the vault Lambda may write there. */
export const VAULT_PIN_ATTRIBUTES = [
  "userId",
  "vaultPin",
  "vaultPinFailures",
  "vaultPinLockouts",
  "vaultPinLockedUntil",
  "vaultPinSetAt",
  "vaultSessionHash",
  "vaultSessionExpiresAt",
] as const;

/** Admins see every secret; anyone else only the ones they saved or are listed in. Guests none. */
export function canAccessVaultSecret(
  secret: Pick<VaultSecret, "createdBy" | "allowedUserIds">,
  userId: string,
  role: Role,
): boolean {
  if (role === "guest") return false;
  if (role === "admin" || secret.createdBy === userId) return true;
  return (secret.allowedUserIds ?? []).includes(userId);
}

/** Who may edit, share or delete a secret: whoever saved it, or an admin. */
export const canManageVaultSecret = (
  secret: Pick<VaultSecret, "createdBy">,
  userId: string,
  role: Role,
): boolean => role === "admin" || (role !== "guest" && secret.createdBy === userId);

export interface VaultPage {
  secrets: VaultSecret[];
}

/** `GET /vault/reveal/{secretId}`. */
export interface VaultReveal {
  secretId: string;
  password: string;
}

/** What a "shared a secret" chat card carries (`Message.vault`): never the password. */
export interface VaultCard {
  secretId: string;
  name: string;
  username?: string;
  website?: string;
}

export const vaultCardText = (card: Pick<VaultCard, "name">): string =>
  `🔒 Shared a Secret: ${card.name}`;

/**
 * The website as a link the app may open: `http(s)` only (no `javascript:`),
 * `https://` added when no scheme was typed; `null` when it isn't a URL.
 */
export function normalizeWebsite(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  return url.toString();
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || undefined);

const websiteField = optionalText(MAX_VAULT_WEBSITE).refine(
  (v) => v === undefined || !!normalizeWebsite(v),
  { message: "use a web address like https://example.com" },
);
// Kept as typed: leading or trailing spaces can be part of a password.
const passwordField = z
  .string()
  .min(1)
  .max(MAX_VAULT_PASSWORD)
  .refine((v) => v.trim().length > 0, { message: "the password is empty" });
const allowedField = z
  .array(z.string().min(1).max(128))
  .max(MAX_VAULT_ALLOWED)
  .transform((ids) => [...new Set(ids)]);

/** `POST /vault`. */
export const CreateVaultSecretSchema = z.object({
  channelId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(MAX_VAULT_NAME),
  username: optionalText(MAX_VAULT_USERNAME),
  website: websiteField,
  password: passwordField,
  /**
   * Who else may see it (Phase 46). Omitted with `share` (`/secret`): the
   * channel's members, as the card is posted for them.
   */
  allowedUserIds: allowedField.optional(),
  /** Also post a "🔒 Shared a Secret" card in the channel (`/secret`). */
  share: z.boolean().optional(),
});
export type CreateVaultSecretInput = z.input<typeof CreateVaultSecretSchema>;

/** `PUT /vault/secrets/{secretId}` (Phase 46): what changes; a new password only when typed. */
export const UpdateVaultSecretSchema = z.object({
  channelId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(MAX_VAULT_NAME),
  // `""` clears them; the schema turns it into `undefined`.
  username: optionalText(MAX_VAULT_USERNAME),
  website: websiteField,
  allowedUserIds: allowedField,
  password: passwordField.optional(),
});
export type UpdateVaultSecretInput = z.input<typeof UpdateVaultSecretSchema>;

// --- The Vault PIN (Phase 46) -----------------------------------------------

export const VAULT_PIN_LENGTH = 4;
/** Wrong PINs in a row before the PIN locks. */
export const VAULT_PIN_MAX_ATTEMPTS = 5;
/** The first lockout; each one after it lasts twice as long, up to a day. */
export const VAULT_PIN_LOCK_MS = 15 * 60 * 1000;
export const VAULT_PIN_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
/** How long an unlocked Vault stays open (the list; reveals ask for the PIN again). */
export const VAULT_SESSION_MS = 15 * 60 * 1000;
/** The header that carries the unlocked Vault's session token. */
export const VAULT_SESSION_HEADER = "x-vault-session";

/** How long the `lockouts`-th lockout (0-based) lasts. */
export const vaultLockMs = (lockouts: number): number =>
  Math.min(VAULT_PIN_MAX_LOCK_MS, VAULT_PIN_LOCK_MS * 2 ** Math.max(0, lockouts));

/** Four digits, and not one anybody would guess first (1111, 1234, 9876…). */
export function vaultPinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "Use exactly 4 digits";
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]!));
  if (steps.size === 1 && [...steps][0]! >= -1 && [...steps][0]! <= 1) {
    return "Too easy to guess: avoid repeated or consecutive digits";
  }
  return null;
}

const pinField = z.string().regex(/^\d{4}$/, { message: "use exactly 4 digits" });

/** `POST /vault/pin`: the first PIN (a weak one is refused). */
export const SetVaultPinSchema = z.object({
  pin: pinField.refine((p) => vaultPinProblem(p) === null, {
    message: "too easy to guess: avoid repeated or consecutive digits",
  }),
});
/** `POST /vault/pin/verify` and `POST /vault/reveal/{secretId}`. */
export const VaultPinSchema = z.object({ pin: pinField });

/** `GET /vault/pin`. */
export interface VaultPinStatus {
  hasPin: boolean;
  /** Epoch ms; set while too many wrong PINs keep it locked. */
  lockedUntil?: number;
  attemptsLeft: number;
}

/** An unlocked Vault: send `token` as `VAULT_SESSION_HEADER` until `expiresAt`. */
export interface VaultUnlock {
  token: string;
  expiresAt: number;
}

/** What a wrong or locked PIN answers (401 or 423), besides `message`. */
export interface VaultPinRefusal {
  code: "PIN_WRONG" | "PIN_LOCKED" | "PIN_NOT_SET" | "VAULT_LOCKED";
  attemptsLeft?: number;
  lockedUntil?: number;
}

// --- `/secret` in the composer ----------------------------------------------

export type SecretCommand =
  /** `/secret` alone: the composer's secret mode (a masked message, gone after 24 h). */
  | { kind: "mode" }
  /** `/secret <title> <password>`: saved in the Vault, a card in the channel. */
  | { kind: "vault"; name: string; password: string }
  /** `/secret something`: a title without a password. */
  | { kind: "incomplete" };

const SECRET_COMMAND = /^\/secret(?:\s+|$)/i;

/**
 * Reads `/secret <title> <password>`: the password is the last word (no
 * spaces), the title everything before it (quotes or brackets around it are
 * dropped). `null` when the text isn't the `/secret` command.
 */
export function parseSecretCommand(text: string): SecretCommand | null {
  const match = SECRET_COMMAND.exec(text.trimStart());
  if (!match) return null;
  const rest = text.trimStart().slice(match[0].length).trim();
  if (!rest) return { kind: "mode" };
  const cut = rest.search(/\s\S*$/);
  if (cut < 0) return { kind: "incomplete" };
  const password = rest.slice(cut).trim();
  const name = unwrap(rest.slice(0, cut).trim()).slice(0, MAX_VAULT_NAME);
  if (!name || !password) return { kind: "incomplete" };
  return { kind: "vault", name, password: unwrap(password) };
}

/** `"title"`, `'title'` or `[title]` → `title`. */
function unwrap(text: string): string {
  const pairs: Record<string, string> = { '"': '"', "'": "'", "[": "]" };
  const close = pairs[text[0] ?? ""];
  return close && text.length > 2 && text.endsWith(close) ? text.slice(1, -1).trim() : text;
}

// --- Generating a strong password -------------------------------------------

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";
export const DEFAULT_PASSWORD_LENGTH = 24;

type RandomBytes = (bytes: Uint8Array) => Uint8Array;
const cryptoBytes: RandomBytes = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** A uniform integer in `[0, max)` (rejection sampling: no modulo bias). */
function randomBelow(max: number, random: RandomBytes): number {
  const limit = 256 - (256 % max);
  const byte = new Uint8Array(1);
  for (;;) {
    random(byte);
    if (byte[0]! < limit) return byte[0]! % max;
  }
}

/**
 * A random password from the OS's CSPRNG: `length` characters (16–128) with at
 * least one lowercase letter, uppercase letter, digit and symbol. Look-alikes
 * (`l`, `I`, `O`, `0`, `1`) are left out so it can be read aloud.
 */
export function generatePassword(
  length = DEFAULT_PASSWORD_LENGTH,
  random: RandomBytes = cryptoBytes,
): string {
  const size = Math.min(128, Math.max(16, Math.floor(length)));
  const sets = [LOWER, UPPER, DIGITS, SYMBOLS];
  const all = sets.join("");
  const chars = sets.map((set) => set[randomBelow(set.length, random)]!);
  while (chars.length < size) chars.push(all[randomBelow(all.length, random)]!);
  // Fisher–Yates, so the guaranteed characters aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1, random);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
