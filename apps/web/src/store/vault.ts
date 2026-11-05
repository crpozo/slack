import type { VaultSecret, VaultUnlock } from "@mindfultech/shared";
import { create } from "zustand";
import { pinRefusalOf, vaultApi, type VaultApi } from "../lib/vaultApi";

/**
 * The Vault (Phase 45): its list, metadata only. Phase 46: the list exists
 * only while the Vault is unlocked; `session` (from the PIN) is kept in
 * memory, never stored, and dropped (with the list) when the Vault locks:
 * when it runs out (`VAULT_SESSION_MS` after the PIN), on the Lock button,
 * or when the server says it expired. Phase 52: one PIN for the whole
 * session, so leaving the view no longer locks it, and Reveal and Copy (in
 * the Vault and on chat cards) use the session instead of asking again.
 * Passwords are never kept here: a revealed one lives in the component that
 * showed it, for a few seconds.
 */
export interface VaultState {
  status: "locked" | "loading" | "ready" | "error";
  session: VaultUnlock | null;
  secrets: VaultSecret[];
  error: string | null;
  /** The PIN was right: keep the session and load the list. */
  unlocked: (session: VaultUnlock) => Promise<void>;
  /** The PIN was right elsewhere (a chat card): keep the session, load nothing. */
  remember: (session: VaultUnlock) => void;
  /** The open session's token, or `null` when the Vault is locked or it ran out. */
  openToken: () => string | null;
  lock: () => void;
  load: () => Promise<void>;
  put: (secret: VaultSecret) => void;
  drop: (secretId: string) => void;
}

const newestFirst = (a: VaultSecret, b: VaultSecret) => b.createdAt - a.createdAt;
const locked = { status: "locked" as const, session: null, secrets: [], error: null };

export function createVaultStore(api: Pick<VaultApi, "list">, now: () => number = Date.now) {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  return create<VaultState>((set, get) => {
    /** Keeps the session and locks the Vault by itself when it runs out. */
    const keep = (session: VaultUnlock) => {
      clearTimeout(expiry);
      expiry = setTimeout(
        () => {
          if (get().session === session) set(locked);
        },
        Math.max(0, session.expiresAt - now()),
      );
    };
    return {
      ...locked,
      unlocked: async (session) => {
        keep(session);
        set({ session, status: "loading", error: null });
        await get().load();
      },
      remember: (session) => {
        keep(session);
        set({ session });
      },
      openToken: () => {
        const { session } = get();
        return session && session.expiresAt > now() ? session.token : null;
      },
      lock: () => {
        clearTimeout(expiry);
        set(locked);
      },
      load: async () => {
        const { session } = get();
        if (!session || session.expiresAt <= now()) return set(locked);
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
      drop: (secretId) =>
        set((s) => ({ secrets: s.secrets.filter((x) => x.secretId !== secretId) })),
    };
  });
}

export const useVault = createVaultStore(vaultApi);
