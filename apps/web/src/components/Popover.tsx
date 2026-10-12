import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  /** Element the popover is placed next to. */
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}

const MARGIN = 8;

/**
 * Floating panel rendered at <body> level (so scroll containers don't clip it),
 * placed below the anchor when it fits, else above, and kept inside the viewport.
 */
export function Popover({ anchor, onClose, children }: Readonly<PopoverProps>) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const a = anchor.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const below = a.bottom + MARGIN;
    const top =
      below + height <= window.innerHeight - MARGIN
        ? below
        : Math.max(MARGIN, a.top - MARGIN - height);
    const left = Math.min(Math.max(MARGIN, a.right - width), window.innerWidth - width - MARGIN);
    setPosition({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50"
      style={position ?? { top: -9999, left: -9999, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
