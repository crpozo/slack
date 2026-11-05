import type { VaultSecret } from "@mindfultech/shared";
import { isDesktopApp } from "./desktop";

// ---------------------------------------------------------------------------
// Vault (Phase 45) on the client: search, and putting a password on the
// clipboard. In the desktop app that goes through its own `copy_secret`
// command (apps/desktop), which uses Tauri's clipboard and wipes the password
// again after `CLIPBOARD_CLEAR_SECONDS` if it's still there. The site is
// never given clipboard read access for that: the check happens natively.
// ---------------------------------------------------------------------------

/** How long a revealed password stays on screen. */
export const REVEAL_MS = 30_000;
/** How long a copied password stays on the clipboard in the desktop app. */
export const CLIPBOARD_CLEAR_SECONDS = 30;

/** Secrets matching every word of `query` (name, username, website, channel), in `channelId` if set. */
export function filterSecrets(
  secrets: VaultSecret[],
  query: string,
  channelId: string,
  channelName: (channelId: string) => string,
): VaultSecret[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return secrets.filter((s) => {
    if (channelId && s.channelId !== channelId) return false;
    const haystack = [s.name, s.username, s.website, channelName(s.channelId), s.createdByName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

interface TauriCore {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}
const tauriCore = (): TauriCore | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;

export interface CopyDeps {
  desktop?: boolean;
  invoke?: TauriCore["invoke"];
  writeText?: (text: string) => Promise<void>;
}

/**
 * Copies a password. Desktop: Tauri's clipboard, cleared after
 * `CLIPBOARD_CLEAR_SECONDS` (`"desktop"`); a desktop app from before the
 * Vault, or the browser, uses the web clipboard (`"web"`), which a site can't
 * clear safely.
 */
export async function copySecret(text: string, deps: CopyDeps = {}): Promise<"desktop" | "web"> {
  const desktop = deps.desktop ?? isDesktopApp();
  const invoke = deps.invoke ?? tauriCore()?.invoke.bind(tauriCore());
  if (desktop && invoke) {
    try {
      await invoke("copy_secret", { text, clearAfterSecs: CLIPBOARD_CLEAR_SECONDS });
      return "desktop";
    } catch (err) {
      console.info("[vault] desktop clipboard unavailable, using the web one", String(err));
    }
  }
  const writeText =
    deps.writeText ??
    ((value: string) => {
      if (!navigator.clipboard) throw new Error("No clipboard here");
      return navigator.clipboard.writeText(value);
    });
  await writeText(text);
  return "web";
}
