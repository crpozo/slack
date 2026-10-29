import { useState } from "react";
import { enablePush, usePush } from "../lib/push";
import { useChat } from "../store";
import { CloseIcon } from "./icons";

const DISMISSED_KEY = "slack.pushPrompt.dismissed";

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One-time bar above the conversation offering notifications. Browsers only
 * show the permission prompt after a click, so the app never asks on its own.
 * Hidden once answered or dismissed (Settings keeps the switch). On phones it
 * sits above the screen's header, so it's plain dark there, not green-tinted.
 */
export function PushPrompt({ phone = false }: Readonly<{ phone?: boolean }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const { status, busy } = usePush();
  const [dismissed, setDismissed] = useState(dismissedBefore);
  const undecided = typeof Notification !== "undefined" && Notification.permission === "default";
  if (!me || dismissed || status !== "off" || !undecided) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage blocked: it will just ask again next time.
    }
  }

  async function enable() {
    try {
      const result = await enablePush(me!.userId);
      if (result === "on") showToast("Notifications are on for this device.", "success");
      dismiss();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't turn on notifications.");
    }
  }

  return (
    <output
      className={`flex items-center gap-3 border-b border-line px-3 py-2 text-sm text-ink sm:px-4 ${
        phone ? "bg-surface-raised" : "bg-primary/15"
      }`}
    >
      <span className="min-w-0 flex-1">
        Get notified about direct messages, private channels and @mentions while you&apos;re away.
      </span>
      <button
        type="button"
        className="btn-primary shrink-0 px-3 py-1.5"
        disabled={busy}
        onClick={() => void enable()}
      >
        {busy ? "Enabling…" : "Enable"}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Not now"
        title="Not now"
        className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
      >
        <CloseIcon />
      </button>
    </output>
  );
}
