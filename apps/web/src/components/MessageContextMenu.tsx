import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { chat } from "../lib/chat";
import { menuActions, placeMenu, type MenuAction, type MenuContext } from "../lib/contextMenu";
import { QUICK_REACTIONS } from "../lib/emoji";
import { openExternal } from "../lib/external";
import { useChat, type ChatMessage } from "../store";
import { CopyIcon, LinkIcon, MessageIcon, PencilIcon, ReplyIcon, TrashIcon } from "./icons";

const LABELS: Record<MenuAction, string> = {
  "copy-selection": "Copy selection",
  copy: "Copy text",
  "open-link": "Open link",
  "copy-link": "Copy link",
  reply: "Reply",
  thread: "Reply in thread",
  edit: "Edit message",
  delete: "Delete message",
};
const ICONS: Record<MenuAction, ReactNode> = {
  "copy-selection": <CopyIcon />,
  copy: <CopyIcon />,
  "open-link": <LinkIcon />,
  "copy-link": <LinkIcon />,
  reply: <ReplyIcon />,
  thread: <MessageIcon />,
  edit: <PencilIcon />,
  delete: <TrashIcon />,
};
/** A line goes before these (the groups: copy, link, conversation, delete). */
const GROUP_START = new Set<MenuAction>(["open-link", "reply", "delete"]);

/**
 * The menu a right-click on a message opens, at the pointer: quick reactions,
 * copying (the selection, or the whole text), the right-clicked link, and the
 * hover toolbar's actions. Arrow keys move, Enter picks, Esc, a click
 * elsewhere, scrolling or leaving the window close it.
 */
export function MessageContextMenu({
  message,
  x,
  y,
  context,
  onReply,
  onThread,
  onEdit,
  onDelete,
  onClose,
}: Readonly<{
  message: ChatMessage;
  x: number;
  y: number;
  context: MenuContext;
  onReply: () => void;
  onThread: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const showToast = useChat((s) => s.showToast);
  const actions = menuActions(message, context);
  const sent = !message.status;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPosition(
      placeMenu(x, y, width, height, { width: window.innerWidth, height: window.innerHeight }),
    );
  }, [x, y]);

  // First item focused once the menu is placed (hidden elements can't take focus),
  // so the keyboard works at once (and Shift+F10 users land in it).
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const close = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    // Any scroll (the message list, the page) moves the message away from the menu.
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  function copy(text: string, what = "Copied") {
    void navigator.clipboard?.writeText(text).then(
      () => showToast(what),
      () => showToast("Couldn't copy"),
    );
  }

  function run(action: MenuAction) {
    onClose();
    switch (action) {
      case "copy-selection":
        return copy(context.selection);
      case "copy":
        return copy(message.text);
      case "open-link":
        return context.link && void openExternal(context.link, { notify: showToast });
      case "copy-link":
        return context.link && copy(context.link, "Link copied");
      case "reply":
        return onReply();
      case "thread":
        return onThread();
      case "edit":
        return onEdit();
      case "delete":
        return onDelete();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      return onClose();
    }
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  }

  const item =
    "flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm outline-none";
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Message actions"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? "visible" : "hidden",
      }}
      className="z-50 w-56 rounded-xl border border-line bg-surface-raised p-1 shadow-xl"
      data-message-menu
    >
      {sent && (
        <div
          className="flex items-center justify-between px-1 pb-1"
          role="group"
          aria-label="React"
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                chat.toggleReaction(message, emoji);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-base outline-none hover:bg-primary/15 focus:bg-primary/15"
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {actions.map((action, i) => (
        <div key={action}>
          {(i === 0 ? sent : GROUP_START.has(action)) && (
            <div className="my-1 h-px bg-line" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => run(action)}
            className={`${item} ${action === "copy" || action === "copy-selection" ? "font-semibold" : ""} ${
              action === "delete"
                ? "text-error hover:bg-error/10 focus:bg-error/10"
                : "text-ink hover:bg-primary/15 focus:bg-primary/15"
            }`}
          >
            <span
              className={action === "delete" ? "text-error" : "text-ink-secondary"}
              aria-hidden="true"
            >
              {ICONS[action]}
            </span>
            {LABELS[action]}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
