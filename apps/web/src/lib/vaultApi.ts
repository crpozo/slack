import type {
  CreateVaultSecretInput,
  Message,
  VaultPage,
  VaultReveal,
  VaultSecret,
} from "@mindfultech/shared";
import { request } from "./tasksApi";

/** What saving answers: the secret's metadata, and the chat card when it was shared. */
export interface SavedSecret {
  secret: VaultSecret;
  message?: Message;
  shared: boolean;
}

/** Vault (Phase 45), on the same HTTP API and auth as the Task Manager. */
export const vaultApi = {
  list: () => request<VaultPage>("GET", "/vault").then((r) => r.secrets),
  create: (input: CreateVaultSecretInput) => request<SavedSecret>("POST", "/vault", input),
  /** The password, decrypted on the server for a member of its channel. */
  reveal: (secretId: string) =>
    request<VaultReveal>("GET", `/vault/reveal/${encodeURIComponent(secretId)}`).then(
      (r) => r.password,
    ),
  remove: (secretId: string) =>
    request<{ deleted: string }>("DELETE", `/vault/secrets/${encodeURIComponent(secretId)}`),
};

export type VaultApi = typeof vaultApi;
