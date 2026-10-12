import { useState } from "react";
import { chat } from "../lib/chat";
import { useChat, useNameOf, type ChatMessage } from "../store";
import { EmojiPicker } from "./EmojiPicker";
import { SmilePlusIcon } from "./icons";
import { Popover } from "./Popover";

/** "Ana, Luis and 2 others reacted with 👍" */
function describe(names: string[], emoji: string): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const who =
    rest > 0
      ? `${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
        : (shown[0] ?? "");
  return `${who} reacted with ${emoji}`;
}

/** Opens the emoji picker under `anchor` and reacts with the chosen emoji. */
export function ReactionPicker({
  message,
  anchor,
  onClose,
}: {
  message: ChatMessage;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <EmojiPicker
        onSelect={(emoji) => {
          const mine = message.reactions?.[emoji]?.includes(useChat.getState().me?.userId ?? "");
          if (!mine) chat.toggleReaction(message, emoji);
          onClose();
        }}
      />
    </Popover>
  );
}

/** Reaction chips under a message: emoji + count, highlighted when I reacted; click toggles. */
export function Reactions({ message }: { message: ChatMessage }) {
  const myUserId = useChat((s) => s.me?.userId);
  const nameOf = useNameOf();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const entries = Object.entries(message.reactions ?? {}).filter(([, users]) => users.length > 0);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, users]) => {
        const mine = myUserId ? users.includes(myUserId) : false;
        const label = describe(
          users.map((id) => (id === myUserId ? "You" : nameOf(id))),
          emoji,
        );
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => chat.toggleReaction(message, emoji)}
            title={label}
            aria-label={`${label}. ${mine ? "Remove" : "Add"} reaction`}
            aria-pressed={mine}
            className={`flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors ${
              mine
                ? "border-primary bg-primary/15 text-ink"
                : "border-line bg-surface text-ink-secondary hover:border-ink-secondary/40"
            }`}
          >
            <span className="text-sm leading-none">{emoji}</span>
            <span className="font-semibold tabular-nums">{users.length}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="flex h-6 items-center rounded-full border border-line px-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
        aria-label="Add reaction"
        title="Add reaction"
      >
        <SmilePlusIcon />
      </button>
      {anchor && (
        <ReactionPicker message={message} anchor={anchor} onClose={() => setAnchor(null)} />
      )}
    </div>
  );
}
