import {
  VAULT_SESSION_HEADER,
  type CreateVaultSecretInput,
  type Message,
  type UpdateVaultSecretInput,
  type VaultPage,
  type VaultPinRefusal,
  type VaultPinStatus,
  type VaultReveal,
  type VaultSecret,
  type VaultUnlock,
} from "@mindfultech/shared";
import { request, TasksApiError } from "./tasksApi";

/** What saving answers: the secret's metadata, and the chat card when it was shared. */
export interface SavedSecret {
  secret: VaultSecret;
  message?: Message;
  shared: boolean;
}

const session = (token: string) => ({ headers: { [VAULT_SESSION_HEADER]: token } });

/**
 * Vault (Phase 45; the PIN and access lists, Phase 46), on the same HTTP API
 * and auth as the Task Manager. The list, edits and deletes need an unlocked
 * Vault's session token; a reveal needs the PIN itself.
 */
export const vaultApi = {
  pinStatus: () => request<VaultPinStatus>("GET", "/vault/pin"),
  /** The first PIN; it also unlocks the Vault. */
  setPin: (pin: string) => request<VaultUnlock>("POST", "/vault/pin", { pin }),
  unlock: (pin: string) => request<VaultUnlock>("POST", "/vault/pin/verify", { pin }),
  /** Admins: clear someone's PIN (they set a new one on their next visit). */
  resetPin: (userId: string) =>
    request<{ reset: string }>("DELETE", `/vault/pin/${encodeURIComponent(userId)}`),
  list: (token: string) =>
    request<VaultPage>("GET", "/vault", undefined, session(token)).then((r) => r.secrets),
  create: (input: CreateVaultSecretInput) => request<SavedSecret>("POST", "/vault", input),
  update: (secretId: string, input: UpdateVaultSecretInput, token: string) =>
    request<{ secret: VaultSecret }>(
      "PUT",
      `/vault/secrets/${encodeURIComponent(secretId)}`,
      input,
      session(token),
    ).then((r) => r.secret),
  /** The password, decrypted on the server for someone it's shared with, given their PIN. */
  reveal: (secretId: string, pin: string) =>
    request<VaultReveal>("POST", `/vault/reveal/${encodeURIComponent(secretId)}`, { pin }).then(
      (r) => r.password,
    ),
  remove: (secretId: string, token: string) =>
    request<{ deleted: string }>(
      "DELETE",
      `/vault/secrets/${encodeURIComponent(secretId)}`,
      undefined,
      session(token),
    ),
};

export type VaultApi = typeof vaultApi;

/** A PIN refusal (wrong, locked, not set) or a locked Vault, from a failed call. */
export function pinRefusalOf(err: unknown): VaultPinRefusal | null {
  if (!(err instanceof TasksApiError) || typeof err.data?.code !== "string") return null;
  return err.data as unknown as VaultPinRefusal;
}

/** "Wrong PIN. 3 tries left…", "Locked until 14:35", or the server's message. */
export function pinErrorText(err: unknown): string {
  const refusal = pinRefusalOf(err);
  if (refusal?.code === "PIN_LOCKED" && refusal.lockedUntil) {
    const at = new Date(refusal.lockedUntil).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `Too many wrong PINs. The Vault is locked until ${at}.`;
  }
  if (err instanceof TasksApiError && err.status === 404) {
    return "This secret was deleted, or it's not shared with you.";
  }
  return err instanceof Error && err.message ? err.message : "Couldn't reach the Vault. Try again.";
}
