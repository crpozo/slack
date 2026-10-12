import { memo, useMemo, useState } from "react";
import { chat } from "../lib/chat";
import { formatTime } from "../lib/channels";
import { QUICK_REACTIONS } from "../lib/emoji";
import { renderMarkdown } from "../lib/markdown";
import { useNameOf, type ChatMessage } from "../store";
import { Attachment } from "./Attachment";
import { Avatar } from "./Avatar";
import { SmilePlusIcon } from "./icons";
import { ReactionPicker, Reactions } from "./Reactions";

/** Hover toolbar: one-click reactions plus the full picker. */
function MessageActions({ message }: { message: ChatMessage }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div
      className={`absolute -top-4 right-4 z-10 items-center gap-0.5 rounded-lg border border-line bg-surface-raised p-0.5 shadow-sm ${
        anchor ? "flex" : "hidden group-hover:flex group-focus-within:flex"
      }`}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => chat.toggleReaction(message, emoji)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-base hover:bg-surface-hover"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
      <button
        type="button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-hover hover:text-ink"
        aria-label="More reactions"
        title="More reactions"
      >
        <SmilePlusIcon />
      </button>
      {anchor && (
        <ReactionPicker message={message} anchor={anchor} onClose={() => setAnchor(null)} />
      )}
    </div>
  );
}

interface MessageItemProps {
  message: ChatMessage;
  grouped: boolean;
  mine: boolean;
}

export const MessageItem = memo(function MessageItem({ message, grouped, mine }: MessageItemProps) {
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  const time = formatTime(message.createdAt);
  const nameOf = useNameOf();
  const name = nameOf(message.userId, message.userEmail);

  return (
    <div
      data-message-id={message.messageId}
      className={`group relative flex gap-3 px-4 hover:bg-surface-sidebar/70 ${grouped ? "py-0.5" : "pt-3 pb-0.5"} ${
        message.status === "pending" ? "opacity-60" : ""
      }`}
    >
      <div className="w-9 shrink-0">
        {grouped ? (
          <time className="invisible block pt-1.5 text-right text-[10px] text-ink-secondary group-hover:visible">
            {time}
          </time>
        ) : (
          <Avatar name={name} mine={mine} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink" title={message.userEmail}>
              {name}
            </span>
            <time
              className="text-xs text-ink-secondary"
              dateTime={new Date(message.createdAt).toISOString()}
            >
              {time}
            </time>
          </div>
        )}

        {message.text && (
          <div
            className={`md mt-0.5 inline-block max-w-full break-words rounded-2xl rounded-tl-sm px-3 py-1.5 text-sm leading-relaxed text-ink ${
              mine ? "bg-primary/15" : "bg-surface-sidebar"
            } ${message.status === "failed" ? "ring-1 ring-error" : ""}`}
            // Safe: renderMarkdown escapes all HTML before adding its own tags.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {message.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <Attachment key={a.key} attachment={a} />
            ))}
          </div>
        )}

        {!message.status && <Reactions message={message} />}

        {message.status === "failed" && (
          <p className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-error" />
            Not sent.
            <button
              type="button"
              onClick={() => chat.retry(message)}
              className="font-semibold text-ink underline decoration-primary decoration-2 underline-offset-2"
            >
              Retry
            </button>
          </p>
        )}
      </div>

      {!message.status && <MessageActions message={message} />}
    </div>
  );
});
