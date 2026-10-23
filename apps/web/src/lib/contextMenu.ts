import type { ChatMessage } from "../store";

// ---------------------------------------------------------------------------
// The message right-click menu (Phase 26): which actions a message offers
// and where the menu goes. Pure, so the rules are tested apart from the UI.
// ---------------------------------------------------------------------------

export type MenuAction =
  "copy" | "copy-selection" | "open-link" | "copy-link" | "reply" | "thread" | "edit" | "delete";

export interface MenuContext {
  mine: boolean;
  /** The list offers threads here (not inside a thread). */
  canThread: boolean;
  /** Text selected inside this message, if any. */
  selection: string;
  /** The link right-clicked, if any. */
  link: string | null;
  /** You wrote it, or you're an admin (Phase 32: `canDeleteMessage`). */
  canDelete?: boolean;
}

/**
 * The actions for `message`, in menu order: copying first (the selection
 * when there is one), then the link, then what the hover toolbar offers.
 * Secrets are never copied from here (their body has its own reveal/copy).
 */
export function menuActions(message: ChatMessage, ctx: MenuContext): MenuAction[] {
  // A deleted message that keeps its thread offers nothing.
  if (message.deletedAt) return [];
  const sent = !message.status;
  const actions: MenuAction[] = [];
  if (!message.isSecret) {
    if (ctx.selection.trim()) actions.push("copy-selection");
    if (message.text) actions.push("copy");
  }
  if (ctx.link) actions.push("open-link", "copy-link");
  if (!sent) return actions;
  actions.push("reply");
  if (ctx.canThread && !message.isSecret) actions.push("thread");
  if (ctx.mine && message.text && !message.isSecret && !message.kind) actions.push("edit");
  // Destructive, so last and on its own (Phase 32).
  if (ctx.canDelete) actions.push("delete");
  return actions;
}

const MARGIN = 8;

/** Top-left of a `width`×`height` menu opened at (`x`, `y`), kept inside the viewport. */
export function placeMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  // Flip to the other side of the pointer when there's no room, like native menus.
  const left = x + width + MARGIN > viewport.width ? x - width : x;
  const top = y + height + MARGIN > viewport.height ? y - height : y;
  return {
    left: Math.max(MARGIN, Math.min(left, viewport.width - width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, viewport.height - height - MARGIN)),
  };
}
