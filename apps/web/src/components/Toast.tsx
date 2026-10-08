import { useEffect } from "react";
import { useChat } from "../store";
import { CloseIcon } from "./icons";

/** Transient error banner fed by `useChat().showToast`. */
export function Toast() {
  const toast = useChat((s) => s.toast);
  const showToast = useChat((s) => s.showToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => showToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast, showToast]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border border-error/40 bg-surface px-4 py-3 text-sm text-ink shadow-lg"
      >
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-error" />
        <span className="flex-1">{toast}</span>
        <button
          type="button"
          onClick={() => showToast(null)}
          className="text-ink-secondary hover:text-ink"
          aria-label="Cerrar"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
