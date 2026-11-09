import type { VaultCard } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { copySecret, REVEAL_MS } from "../lib/vault";
import { pinRefusalOf, vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { useVault } from "../store/vault";
import { CheckIcon, CopyIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, LockIcon } from "./icons";
import { PinPrompt } from "./VaultPin";

const ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-ink-secondary transition hover:border-primary/50 hover:bg-primary/[0.1] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
/** The chat card's buttons (Phase 56): borderless, 24 px, icon only. */
const MINI_BUTTON =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[13px] text-ink-secondary transition hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
/** A hidden or revealed value in the chat card: one thin monospace chip. */
const MINI_VALUE = "min-w-0 max-w-[150px] truncate rounded px-1 font-mono text-xs";
const MASK = "••••••••";

/** "Copied" for 1.5 s after `copy()`. */
function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return [copied, () => setCopied(true)];
}

/**
 * A secret's password, masked, with Reveal (eye) and Copy. Both need the
 * Vault unlocked (Phase 52: one PIN opens it for the session, wherever it's
 * typed, so only the first asks), then the server, which decrypts it only
 * for someone it's shared with. A revealed password hides itself again after
 * `REVEAL_MS`, when the tab is hidden, and when this unmounts; it's never
 * stored anywhere else. Copying a password already on screen asks nothing.
 */
export function PasswordControls({
  secretId,
  name,
  inline = false,
}: Readonly<{
  secretId: string;
  name: string;
  /** The chat card's thin variant: a small chip and borderless 24 px buttons. */
  inline?: boolean;
}>) {
  const showToast = useChat((s) => s.showToast);
  const [password, setPassword] = useState<string | null>(null);
  const [asking, setAsking] = useState<"reveal" | "copy" | null>(null);
  const [copied, markCopied] = useCopied();

  useEffect(() => {
    if (password === null) return;
    const hide = () => setPassword(null);
    const timer = setTimeout(hide, REVEAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [password]);
  /** Reveals or copies with the open session; without one (or a stale one), asks for the PIN. */
  async function act(what: "reveal" | "copy") {
    const token = useVault.getState().openToken();
    if (!token) return setAsking(what);
    try {
      await use(what, await vaultApi.reveal(secretId, token));
    } catch (err) {
      if (pinRefusalOf(err)?.code === "VAULT_LOCKED") {
        useVault.getState().lock();
        return setAsking(what);
      }
      showToast(err instanceof Error && err.message ? err.message : "Couldn't reveal it", "error");
    }
  }
  async function use(what: "reveal" | "copy", value: string) {
    if (what === "reveal") setPassword(value);
    else await copy(value);
  }

  async function copy(value: string) {
    try {
      const where = await copySecret(value);
      markCopied();
      showToast(
        where === "desktop"
          ? `Copied the ${name} password · cleared from the clipboard in 30 s`
          : `Copied the ${name} password`,
        "success",
      );
    } catch {
      showToast("Couldn't copy the password", "error");
    }
  }

  const button = inline ? MINI_BUTTON : ICON_BUTTON;
  return (
    <div
      className={`flex min-w-0 items-center ${inline ? "gap-0.5" : "gap-1.5"}`}
      data-password-controls={secretId}
    >
      <code
        className={`${
          inline
            ? MINI_VALUE
            : "min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 font-mono text-[13px]"
        } ${password === null ? "tracking-[0.2em] text-ink-secondary" : "select-all text-ink"}`}
        aria-label={password === null ? "Hidden password" : `${name} password`}
        data-password={password === null ? "hidden" : "shown"}
      >
        {password ?? (inline ? MASK : "••••••••••")}
      </code>
      <button
        type="button"
        className={button}
        onClick={() => (password === null ? void act("reveal") : setPassword(null))}
        aria-label={password === null ? `Reveal the ${name} password` : "Hide the password"}
        title={password === null ? "Reveal" : "Hide"}
        data-reveal
      >
        {password === null ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <button
        type="button"
        className={button}
        onClick={() => void (password === null ? act("copy") : copy(password))}
        aria-label={`Copy the ${name} password`}
        title="Copy to clipboard"
        data-copy-password
      >
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </button>
      {asking && (
        <PinPrompt
          title={asking === "reveal" ? `Reveal ${name}` : `Copy ${name}`}
          onClose={() => setAsking(null)}
          onSubmit={async (pin) => {
            // The PIN unlocks the Vault for the session: the next reveal won't ask.
            const session = await vaultApi.unlock(pin);
            useVault.getState().remember(session);
            await use(asking, await vaultApi.reveal(secretId, session.token));
          }}
        />
      )}
    </div>
  );
}

/**
 * The chat card's username (Phase 56): masked like the password, with its own
 * Reveal and Copy. The card already carries it (it's no secret to the
 * channel), so neither needs the PIN, and Copy uses the ordinary clipboard
 * (no clearing after 30 s, unlike a password).
 */
export function UsernameControls({ username, name }: Readonly<{ username: string; name: string }>) {
  const showToast = useChat((s) => s.showToast);
  const [shown, setShown] = useState(false);
  const [copied, markCopied] = useCopied();
  async function copy() {
    try {
      await copySecret(username, { desktop: false });
      markCopied();
      showToast(`Copied the ${name} username`, "success");
    } catch {
      showToast("Couldn't copy the username", "error");
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-username-controls>
      <code
        className={`${MINI_VALUE} ${shown ? "select-all text-ink" : "tracking-[0.2em] text-ink-secondary"}`}
        aria-label={shown ? `${name} username` : "Hidden username"}
        data-username={shown ? "shown" : "hidden"}
      >
        {shown ? username : MASK}
      </code>
      <button
        type="button"
        className={MINI_BUTTON}
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? "Hide the username" : `Reveal the ${name} username`}
        title={shown ? "Hide" : "Reveal"}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
      <button
        type="button"
        className={MINI_BUTTON}
        onClick={() => void copy()}
        aria-label={`Copy the ${name} username`}
        title="Copy to clipboard"
        data-copy-username
      >
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </button>
    </div>
  );
}

/**
 * "Launch": the secret's website (validated `http(s)` on the server), opened
 * outside the app. Web: a new tab without access back to this page. Desktop:
 * the OS's default browser through Tauri's opener plugin (Tauri 2's
 * successor to `shell.open`), never inside the app's window.
 */
export function LaunchButton({
  href,
  name,
  compact = false,
}: Readonly<{ href: string; name: string; compact?: boolean }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!isDesktopApp()) return;
        e.preventDefault();
        void openExternal(href);
      }}
      className={`inline-flex shrink-0 items-center rounded-lg border border-primary/40 bg-primary/[0.1] font-semibold text-[#6fcf97] transition hover:border-primary hover:bg-primary/20 hover:text-[#8fe0b0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        compact ? "h-6 gap-1 rounded-md px-2 text-[11px]" : "h-8 gap-1.5 px-2.5 text-xs"
      }`}
      title={`Open ${href}`}
      aria-label={`Launch ${name} (${hostOf(href)})`}
      data-launch
    >
      <ExternalLinkIcon aria-hidden="true" /> Launch
    </a>
  );
}

const hostOf = (href: string) => {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
};

/** The secret's website, opened outside the app (validated `http(s)` on the server). */
export function WebsiteLink({ href }: Readonly<{ href: string }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!isDesktopApp()) return;
        e.preventDefault();
        void openExternal(href);
      }}
      className="inline-flex min-w-0 items-center gap-1 text-xs text-primary hover:underline"
      title={href}
    >
      <span className="truncate">{hostOf(href)}</span>
      <ExternalLinkIcon className="shrink-0" aria-hidden="true" />
    </a>
  );
}

/**
 * "🔒 Shared a Secret" in the chat (`/secret`, Phase 45; one thin row since
 * Phase 56): the title, then the username and the password, both masked, each
 * with Reveal and Copy, and Launch on the right. The password comes from the
 * Vault (PIN first, unless it's open), which only answers people it's shared
 * with; the card never holds it. Wraps onto a second line on a narrow screen.
 */
export function VaultSecretCard({ card, mine }: Readonly<{ card: VaultCard; mine: boolean }>) {
  return (
    <div
      className={`mt-0.5 flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-2.5 py-1 text-[13px] ${
        mine ? "border-primary/25 bg-primary/[0.06]" : "border-white/10 bg-white/[0.03]"
      }`}
      data-vault-card={card.secretId}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <LockIcon className="shrink-0 text-xs text-warning" aria-hidden="true" />
        <span className="max-w-[180px] truncate font-medium text-ink" title={card.name}>
          {card.name}
        </span>
      </span>
      {card.username && (
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-[11px] text-ink-secondary">User</span>
          <UsernameControls username={card.username} name={card.name} />
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1">
        <span className="text-[11px] text-ink-secondary">Password</span>
        <PasswordControls secretId={card.secretId} name={card.name} inline />
      </span>
      {card.website && (
        <span className="ml-auto">
          <LaunchButton href={card.website} name={card.name} compact />
        </span>
      )}
    </div>
  );
}
