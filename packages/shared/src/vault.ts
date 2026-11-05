import { z } from "zod";

// ---------------------------------------------------------------------------
// Vault (Phase 45): the team's passwords and API keys, each tied to a channel
// (the project it belongs to). The server encrypts the password with AWS KMS
// before it's stored, lists only the metadata, and decrypts one password at a
// time, for members of its channel only (`GET /vault/reveal/{secretId}`).
// `/secret <title> <password>` in a channel saves one and posts a card.
// ---------------------------------------------------------------------------

export const MAX_VAULT_NAME = 100;
export const MAX_VAULT_USERNAME = 200;
export const MAX_VAULT_WEBSITE = 500;
/** KMS encrypts at most 4 KB at a time; 1,024 characters are at most 4 KB of UTF-8. */
export const MAX_VAULT_PASSWORD = 1024;

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
  /** Epoch ms. */
  createdAt: number;
}

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

/** `POST /vault`. */
export const CreateVaultSecretSchema = z.object({
  channelId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(MAX_VAULT_NAME),
  username: optionalText(MAX_VAULT_USERNAME),
  website: optionalText(MAX_VAULT_WEBSITE).refine((v) => v === undefined || !!normalizeWebsite(v), {
    message: "use a web address like https://example.com",
  }),
  // Kept as typed: leading or trailing spaces can be part of a password.
  password: z
    .string()
    .min(1)
    .max(MAX_VAULT_PASSWORD)
    .refine((v) => v.trim().length > 0, { message: "the password is empty" }),
  /** Also post a "🔒 Shared a Secret" card in the channel (`/secret`). */
  share: z.boolean().optional(),
});
export type CreateVaultSecretInput = z.input<typeof CreateVaultSecretSchema>;

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
