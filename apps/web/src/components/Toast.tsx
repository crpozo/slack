import { useCallback, useEffect, useState, type ReactNode } from "react";
import { TOAST_MS, type ToastTone } from "../lib/toast";
import { useChat } from "../store";
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from "./icons";

const TONES: Record<ToastTone, { icon: ReactNode; badge: string; border: string }> = {
  success: {
    icon: <CheckIcon />,
    badge: "bg-primary/20 text-primary",
    border: "border-primary/30",
  },
  info: {
    icon: <InfoIcon />,
    badge: "bg-white/10 text-ink-secondary",
    border: "border-white/10",
  },
  error: {
    icon: <AlertIcon />,
    badge: "bg-error/15 text-error",
    border: "border-error/40",
  },
};

/** How long the toast takes to fade away once it's done. */
const LEAVE_MS = 160;

/**
 * The toast fed by `useChat().showToast`: a small glass pill above the
 * composer that slides in and fades away. Success and info read calmly (a ✓
 * in the brand green, or a neutral ⓘ) and go sooner; errors are red, stay
 * longest, and are announced at once (`role="alert"`).
 */
export function Toast() {
  const toast = useChat((s) => s.toast);
  const showToast = useChat((s) => s.showToast);
  const [leaving, setLeaving] = useState(false);

  const dismiss = useCallback(() => {
    setLeaving(true);
    setTimeout(() => showToast(null), LEAVE_MS);
  }, [showToast]);

  useEffect(() => {
    if (!toast) return;
    setLeaving(false);
    const timer = setTimeout(dismiss, TOAST_MS[toast.tone]);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  if (!toast) return null;
  const tone = TONES[toast.tone];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
      <div
        key={toast.id}
        role={toast.tone === "error" ? "alert" : "status"}
        data-tone={toast.tone}
        className={`pointer-events-auto flex max-w-md items-center gap-2.5 rounded-2xl border py-2 pl-2 pr-1.5 text-sm text-ink shadow-[0_12px_32px_rgb(0_0_0/0.4)] glass-strong ${tone.border} ${
          leaving ? "toast-out" : "toast-in"
        }`}
        data-toast
      >
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base ${tone.badge}`}
        >
          {tone.icon}
        </span>
        <span className="min-w-0 flex-1 py-0.5 leading-snug">{toast.message}</span>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-full p-1.5 text-ink-secondary hover:bg-white/10 hover:text-ink"
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
