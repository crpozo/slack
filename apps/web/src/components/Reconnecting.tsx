import { useEffect, useState } from "react";

/** Whole seconds until `deadline` (epoch ms), ticking; `null` without one. */
export function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Over the call's video while its connection is being restored (Phase 34):
 * the last frame dims, a spinner says "Reconnecting…" and how long is left
 * before the call gives up (30 seconds after the drop). `compact` for the
 * small floating and popped-out windows.
 */
export function ReconnectingOverlay({
  deadline,
  compact = false,
}: Readonly<{ deadline: number; compact?: boolean }>) {
  const left = useSecondsLeft(deadline);
  return (
    <div
      role="status"
      aria-live="polite"
      data-reconnecting
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/65 px-3 text-center text-white backdrop-blur-[2px]"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`animate-spin text-warning ${compact ? "h-5 w-5" : "h-8 w-8"}`}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="3"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <p className={`font-semibold ${compact ? "text-xs" : "text-base"}`}>Reconnecting…</p>
      {!compact && (
        <p className="max-w-xs text-sm text-white/75">
          The connection dropped. Trying to restore the call
          {left !== null && ` (${left} s left)`}.
        </p>
      )}
      {compact && left !== null && (
        <p className="text-[11px] tabular-nums text-white/75">{left} s left</p>
      )}
    </div>
  );
}
