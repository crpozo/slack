import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md";
}

/** Centered dialog with backdrop; Esc or clicking outside closes it. */
export function Modal({ title, onClose, children, footer, width = "md" }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // Focus the first field once, so keyboard users land inside the dialog.
    panel.current?.querySelector<HTMLElement>("input, textarea, button:not([data-close])")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/40 sm:items-center sm:p-4"
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface-raised shadow-xl sm:rounded-2xl ${
          width === "sm" ? "sm:max-w-sm" : "sm:max-w-md"
        }`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-semibold text-ink">{title}</h2>
          <button
            type="button"
            data-close
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Secondary button used next to `btn-primary` in modal footers. */
export function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-lg px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
    />
  );
}
