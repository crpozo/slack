import type { VaultSecret, VaultUnlock } from "@mindfultech/shared";
import { create } from "zustand";
import { pinRefusalOf, vaultApi, type VaultApi } from "../lib/vaultApi";

/**
 * The Vault (Phase 45): its list, metadata only. Phase 46: the list exists
 * only while the Vault is unlocked; `session` (from the PIN) is kept in
 * memory, never stored, and dropped (with the list) when the Vault locks:
 * on leaving the view, on the Lock button, or when the server says it
 * expired. Passwords are never kept here: a revealed one lives in the
 * component that showed it, for a few seconds.
 */
export interface VaultState {
  status: "locked" | "loading" | "ready" | "error";
  session: VaultUnlock | null;
  secrets: VaultSecret[];
  error: string | null;
  /** The PIN was right: keep the session and load the list. */
  unlocked: (session: VaultUnlock) => Promise<void>;
  lock: () => void;
  load: () => Promise<void>;
  put: (secret: VaultSecret) => void;
  drop: (secretId: string) => void;
}

const newestFirst = (a: VaultSecret, b: VaultSecret) => b.createdAt - a.createdAt;
const locked = { status: "locked" as const, session: null, secrets: [], error: null };

export function createVaultStore(api: Pick<VaultApi, "list">) {
  return create<VaultState>((set, get) => ({
    ...locked,
    unlocked: async (session) => {
      set({ session, status: "loading", error: null });
      await get().load();
    },
    lock: () => set(locked),
    load: async () => {
      const { session } = get();
      if (!session || session.expiresAt <= Date.now()) return set(locked);
      if (get().status !== "ready") set({ status: "loading", error: null });
      try {
        const secrets = (await api.list(session.token)).sort(newestFirst);
        // Locked meanwhile (left the view): don't bring the list back.
        if (get().session === session) set({ status: "ready", secrets });
      } catch (err) {
        if (pinRefusalOf(err)?.code === "VAULT_LOCKED") return set(locked);
        set({
          status: get().secrets.length ? "ready" : "error",
          error: err instanceof Error ? err.message : "Couldn't load the Vault.",
        });
      }
    },
    put: (secret) =>
      set((s) => ({
        secrets: [...s.secrets.filter((x) => x.secretId !== secret.secretId), secret].sort(
          newestFirst,
        ),
      })),
    drop: (secretId) => set((s) => ({ secrets: s.secrets.filter((x) => x.secretId !== secretId) })),
  }));
}

export const useVault = createVaultStore(vaultApi);
