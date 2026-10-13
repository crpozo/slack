import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
}

/**
 * Shows a native `<dialog>` as modal while mounted (focus trap, top layer, inert page).
 * Esc closes it natively; that, or a press on the backdrop, calls `onClose`.
 */
export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // `close` is dispatched asynchronously: ignore a stale one (e.g. from StrictMode's
    // unmount/remount) that arrives after the dialog was shown again.
    const onNativeClose = () => {
      if (!dialog.open) closeRef.current();
    };
    // The backdrop belongs to the dialog: a press outside its box targets the dialog itself.
    const onBackdropPress = (e: MouseEvent) => {
      if (e.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside =
        e.clientX >= box.left &&
        e.clientX <= box.right &&
        e.clientY >= box.top &&
        e.clientY <= box.bottom;
      if (!inside) closeRef.current();
    };
    dialog.addEventListener("close", onNativeClose);
    dialog.addEventListener("mousedown", onBackdropPress);
    return () => {
      // Detach first: closing here (unmount) must not report back as a user close.
      dialog.removeEventListener("close", onNativeClose);
      dialog.removeEventListener("mousedown", onBackdropPress);
      if (dialog.open) dialog.close();
    };
  }, []);

  return ref;
}

const WIDTHS = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-2xl" } as const;

/** Centered dialog with backdrop; Esc or clicking outside closes it. */
export function Modal({ title, onClose, children, footer, width = "md" }: Readonly<ModalProps>) {
  const dialog = useModalDialog(onClose);

  useEffect(() => {
    // Focus the first field once, so keyboard users land on it rather than on "Close".
    dialog.current
      ?.querySelector<HTMLElement>("input, textarea, button:not([data-close])")
      ?.focus();
  }, [dialog]);

  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      className={`m-0 mt-auto max-h-[90vh] w-full max-w-full overflow-hidden rounded-t-2xl border border-line bg-surface-raised p-0 text-ink shadow-xl backdrop:bg-scrim/50 backdrop:backdrop-blur-sm sm:m-auto sm:rounded-2xl ${WIDTHS[width]}`}
    >
      <div className="flex max-h-[90vh] flex-col">
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
          <footer className="flex justify-end gap-2 border-t border-line px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:pb-3">
            {footer}
          </footer>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

/** Secondary button used next to `btn-primary` in modal footers. */
export function SecondaryButton(props: Readonly<React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-lg px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
    />
  );
}
