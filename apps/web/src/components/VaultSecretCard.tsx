import type { VaultCard } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { TasksApiError } from "../lib/tasksApi";
import { copySecret, REVEAL_MS } from "../lib/vault";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { CheckIcon, CopyIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, LockIcon } from "./icons";

const ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-ink-secondary transition hover:border-primary/50 hover:bg-primary/[0.1] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";

const revealError = (err: unknown) =>
  err instanceof TasksApiError && err.status === 404
    ? "This secret was deleted, or it's not shared with you."
    : err instanceof Error && err.message
      ? err.message
      : "Couldn't reach the Vault. Try again.";

/**
 * A secret's password, masked, with Reveal (eye) and Copy. Both ask the
 * server, which decrypts it for members of the secret's channel only. A
 * revealed password hides itself again after `REVEAL_MS`, when the tab is
 * hidden, and when this unmounts; it's never stored anywhere else.
 */
export function PasswordControls({
  secretId,
  name,
  compact = false,
}: Readonly<{ secretId: string; name: string; compact?: boolean }>) {
  const showToast = useChat((s) => s.showToast);
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reveal" | "copy" | null>(null);
  const [copied, setCopied] = useState(false);

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
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function toggleReveal() {
    if (password !== null) {
      setPassword(null);
      return;
    }
    setBusy("reveal");
    try {
      setPassword(await vaultApi.reveal(secretId));
    } catch (err) {
      showToast(revealError(err), "error");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    setBusy("copy");
    try {
      const where = await copySecret(password ?? (await vaultApi.reveal(secretId)));
      setCopied(true);
      showToast(
        where === "desktop"
          ? `Copied the ${name} password · cleared from the clipboard in 30 s`
          : `Copied the ${name} password`,
        "success",
      );
    } catch (err) {
      showToast(
        err instanceof TasksApiError ? revealError(err) : "Couldn't copy the password",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-password-controls={secretId}>
      <code
        className={`min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 font-mono text-[13px] ${
          password === null ? "tracking-[0.2em] text-ink-secondary" : "select-all text-ink"
        } ${compact ? "max-w-[220px]" : ""}`}
        aria-label={password === null ? "Hidden password" : `${name} password`}
        data-password={password === null ? "hidden" : "shown"}
      >
        {password ?? "••••••••••"}
      </code>
      <button
        type="button"
        className={ICON_BUTTON}
        onClick={() => void toggleReveal()}
        disabled={busy !== null}
        aria-label={password === null ? `Reveal the ${name} password` : "Hide the password"}
        title={password === null ? "Reveal" : "Hide"}
        data-reveal
      >
        {password === null ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        onClick={() => void copy()}
        disabled={busy !== null}
        aria-label={`Copy the ${name} password`}
        title="Copy to clipboard"
        data-copy-password
      >
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </button>
    </div>
  );
}

/** The secret's website, opened outside the app (validated `http(s)` on the server). */
export function WebsiteLink({ href }: Readonly<{ href: string }>) {
  let host = href;
  try {
    host = new URL(href).host;
  } catch {
    // shown as stored
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (!isDesktopApp()) return;
        e.preventDefault();
        void openExternal(href);
      }}
      className="inline-flex min-w-0 items-center gap-1 text-xs text-primary hover:underline"
      title={href}
    >
      <span className="truncate">{host}</span>
      <ExternalLinkIcon className="shrink-0" aria-hidden="true" />
    </a>
  );
}

/**
 * "🔒 Shared a Secret" in the chat (`/secret`, Phase 45): the secret's name,
 * username and website; Reveal and Copy fetch the password from the Vault,
 * which only answers members of this channel. The card never holds it.
 */
export function VaultSecretCard({ card, mine }: Readonly<{ card: VaultCard; mine: boolean }>) {
  return (
    <div
      className={`mt-0.5 flex w-full max-w-[420px] flex-col gap-2.5 rounded-2xl rounded-tl-sm border border-warning/30 px-3.5 py-3 text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] backdrop-blur-md ${
        mine ? "bg-primary/[0.12]" : "bg-white/[0.05]"
      }`}
      data-vault-card={card.secretId}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-warning/40 bg-warning/15 text-warning"
          aria-hidden="true"
        >
          <LockIcon />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
            🔒 Shared a Secret
          </span>
          <span className="truncate font-semibold text-ink">{card.name}</span>
        </div>
      </div>
      {(card.username || card.website) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
          {card.username && (
            <span className="min-w-0 truncate">
              User: <span className="font-mono text-ink/90">{card.username}</span>
            </span>
          )}
          {card.website && <WebsiteLink href={card.website} />}
        </div>
      )}
      <PasswordControls secretId={card.secretId} name={card.name} />
    </div>
  );
}
