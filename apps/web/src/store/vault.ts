import type { VaultSecret } from "@mindfultech/shared";
import { create } from "zustand";
import { vaultApi, type VaultApi } from "../lib/vaultApi";

/**
 * The Vault's list (Phase 45): metadata only, loaded when the view opens.
 * Passwords are never kept here: a revealed one lives in the component that
 * showed it, for a few seconds.
 */
export interface VaultState {
  status: "idle" | "loading" | "ready" | "error";
  secrets: VaultSecret[];
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  put: (secret: VaultSecret) => void;
  drop: (secretId: string) => void;
}

const newestFirst = (a: VaultSecret, b: VaultSecret) => b.createdAt - a.createdAt;

export function createVaultStore(api: Pick<VaultApi, "list">) {
  return create<VaultState>((set, get) => ({
    status: "idle",
    secrets: [],
    error: null,
    load: async (force = false) => {
      const s = get();
      if (s.status === "loading" || (!force && s.status === "ready")) return;
      set({ status: "loading", error: null });
      try {
        set({ status: "ready", secrets: (await api.list()).sort(newestFirst) });
      } catch (err) {
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
