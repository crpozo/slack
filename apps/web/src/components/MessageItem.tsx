import { memo, useMemo } from "react";
import { chat } from "../lib/chat";
import { displayName, formatTime } from "../lib/channels";
import { renderMarkdown } from "../lib/markdown";
import type { ChatMessage } from "../store";
import { Attachment } from "./Attachment";
import { Avatar } from "./Avatar";

interface MessageItemProps {
  message: ChatMessage;
  grouped: boolean;
  mine: boolean;
}

export const MessageItem = memo(function MessageItem({ message, grouped, mine }: MessageItemProps) {
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  const time = formatTime(message.createdAt);

  return (
    <div
      data-message-id={message.messageId}
      className={`group flex gap-3 px-4 hover:bg-surface-sidebar/70 ${grouped ? "py-0.5" : "pt-3 pb-0.5"} ${
        message.status === "pending" ? "opacity-60" : ""
      }`}
    >
      <div className="w-9 shrink-0">
        {grouped ? (
          <time className="invisible block pt-1.5 text-right text-[10px] text-ink-secondary group-hover:visible">
            {time}
          </time>
        ) : (
          <Avatar email={message.userEmail} mine={mine} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink">{displayName(message.userEmail)}</span>
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

        {message.status === "failed" && (
          <p className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-error" />
            No se envió.
            <button
              type="button"
              onClick={() => chat.retry(message)}
              className="font-semibold text-ink underline decoration-primary decoration-2 underline-offset-2"
            >
              Reintentar
            </button>
          </p>
        )}
      </div>
    </div>
  );
});
