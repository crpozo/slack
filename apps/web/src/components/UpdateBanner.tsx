import { useEffect, useState } from "react";
import { watchForUpdates } from "../lib/updates";

/**
 * "A new version is available" (Phase 39b): shown at the top of the window
 * once a deploy has replaced the bundle this tab is running (see
 * lib/updates.ts). Reload gets the new one; Later hides it for this tab
 * (nothing is stored, so the next load, which is the new version anyway,
 * starts clean).
 */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => watchForUpdates(() => setAvailable(true)), []);

  if (!available || dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-update-banner
      className="fixed inset-x-0 top-0 z-[60] flex justify-center px-3 pt-3 pointer-events-none"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <div className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/50 bg-surface-raised px-4 py-2.5 text-sm text-ink shadow-lg">
        <span aria-hidden="true">✨</span>
        <span className="flex-1">
          <strong className="font-semibold">New version available.</strong> Reload to get the latest
          update.
        </span>
        <button type="button" onClick={() => location.reload()} className="btn-primary px-3 py-1">
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-md px-2 py-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
        >
          Later
        </button>
      </div>
    </div>
  );
}
