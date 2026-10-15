import { isDmChannel, readBy, replyPreview, type ReplySnapshot } from "@mindfultech/shared";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { chat } from "../lib/chat";
import { formatTime, seenByLine } from "../lib/channels";
import { QUICK_REACTIONS } from "../lib/emoji";
import { useMessageGestures } from "../lib/gestures";
import { renderMarkdown } from "../lib/markdown";
import { useChat, useNameOf, type ChatMessage } from "../store";
import { Attachment } from "./Attachment";
import { Avatar } from "./Avatar";
import { CheckCheckIcon, CopyIcon, PencilIcon, ReplyIcon, SmilePlusIcon } from "./icons";
import { ReactionPicker, Reactions } from "./Reactions";

/** The message whose toolbar a long press opened (touch screens; one at a time). */
const usePressed = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({
  id: null,
  set: (id) => set({ id }),
}));

const snapshotOf = (message: ChatMessage): ReplySnapshot => ({
  messageId: message.messageId,
  sk: message.sk,
  userId: message.userId,
  preview: replyPreview(message.text),
  hasAttachments: message.attachments.length > 0,
});

/** Scrolls to a loaded message and flashes it; says so if it's further back in history. */
function jumpTo(messageId: string) {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!el) {
    useChat.getState().showToast("That message is further back in the history.");
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("bg-primary/20");
  setTimeout(() => el.classList.remove("bg-primary/20"), 1500);
}

const actionButton =
  "flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-hover hover:text-ink";

/**
 * Toolbar: one-tap reactions, the full picker, Reply and (touch) Copy text.
 * With a mouse it shows on hover; on touch screens only after a long press —
 * a plain tap never opens it (iOS emulates hover on tap, hence `hover:hover`).
 */
function MessageActions({
  message,
  pressed,
  mine,
}: Readonly<{ message: ChatMessage; pressed: boolean; mine: boolean }>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = usePressed((s) => s.set);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const setEditing = useChat((s) => s.setEditing);
  const ref = useRef<HTMLDivElement>(null);

  // A long-press toolbar closes on the next touch anywhere else.
  useEffect(() => {
    if (!pressed) return;
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pressed, close]);

  const done = () => close(null);
  let visibility =
    "hidden [@media(hover:hover)]:group-hover:flex [@media(hover:hover)]:group-focus-within:flex";
  if (anchor || pressed) visibility = "flex";
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Message actions"
      className={`absolute -top-4 right-4 z-10 items-center gap-0.5 rounded-lg border border-line bg-surface-raised p-0.5 shadow-sm ${visibility}`}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => {
            chat.toggleReaction(message, emoji);
            done();
          }}
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
      <button
        type="button"
        onClick={() => {
          setReplyTo(message.channelId, snapshotOf(message));
          done();
        }}
        className={actionButton}
        aria-label="Reply"
        title="Reply"
      >
        <ReplyIcon />
      </button>
      {mine && message.text && (
        <button
          type="button"
          onClick={() => {
            setEditing(message.channelId, {
              sk: message.sk,
              messageId: message.messageId,
              text: message.text,
            });
            done();
          }}
          className={actionButton}
          aria-label="Edit message"
          title="Edit message"
        >
          <PencilIcon />
        </button>
      )}
      {pressed && message.text && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(message.text).then(
              () => useChat.getState().showToast("Copied"),
              () => {},
            );
            done();
          }}
          className={actionButton}
          aria-label="Copy text"
          title="Copy text"
        >
          <CopyIcon />
        </button>
      )}
      {anchor && (
        <ReactionPicker
          message={message}
          anchor={anchor}
          onClose={() => {
            setAnchor(null);
            done();
          }}
        />
      )}
    </div>
  );
}

/** The message a reply answers, above the reply; tap to jump to it. */
function ReplyQuote({ reply }: Readonly<{ reply: ReplySnapshot }>) {
  const nameOf = useNameOf();
  return (
    <button
      type="button"
      onClick={() => jumpTo(reply.messageId)}
      className="mb-0.5 mt-0.5 flex max-w-full items-start gap-1.5 rounded-md border-l-2 border-primary bg-surface-sidebar/80 px-2 py-1 text-left text-xs text-ink-secondary hover:bg-surface-hover"
      aria-label={`In reply to ${nameOf(reply.userId)}: ${reply.preview}`}
    >
      <ReplyIcon className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold text-ink">{nameOf(reply.userId)}</span>{" "}
        <span className="line-clamp-2 break-words">
          {reply.preview || (reply.hasAttachments ? "📎 Attachment" : "")}
        </span>
      </span>
    </button>
  );
}

interface MessageItemProps {
  message: ChatMessage;
  grouped: boolean;
  mine: boolean;
  /** The newest message of the conversation (where a DM shows its read receipt). */
  last?: boolean;
}

/** "(edited)" after the time, with the edit's time on hover. */
function EditedMark({ editedAt }: Readonly<{ editedAt?: number }>) {
  return (
    <span
      className="text-xs text-ink-secondary"
      title={editedAt ? `Edited at ${formatTime(editedAt)}` : "Edited"}
    >
      (edited)
    </span>
  );
}

/**
 * Read receipt of your newest message in a DM: shown once the other person's
 * watermark covers it (derived from the channel's reads, never per message).
 */
function ReadReceipt({ message }: Readonly<{ message: ChatMessage }>) {
  // A primitive from the selector: a fresh array each render would loop useSyncExternalStore.
  const read = useChat((s) => readBy(message, s.reads[message.channelId]).length > 0);
  if (!read) return null;
  return (
    <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-secondary">
      <CheckCheckIcon className="text-primary" />
      Read
    </span>
  );
}

/** Avatars shown before "+N" in a channel's "Seen by". */
const SEEN_AVATARS = 3;

/**
 * Channels: who has caught up, under the newest message — "Seen by Ana, Luis
 * and 3 others" with their avatars (everyone's names in the tooltip). Derived
 * from each member's read watermark on the channel, like DMs' "Read".
 */
function ChannelSeenBy({ message }: Readonly<{ message: ChatMessage }>) {
  const nameOf = useNameOf();
  // A string from the selector (stable across renders), split back into ids.
  const readers = useChat((s) =>
    readBy(message, s.reads[message.channelId])
      .filter((id) => id !== s.me?.userId)
      .join(","),
  );
  if (!readers) return null;
  const names = readers.split(",").map((id) => nameOf(id));
  const line = seenByLine(names);
  return (
    <span
      className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-secondary"
      title={`Seen by ${names.join(", ")}`}
    >
      <span className="flex -space-x-1" aria-hidden="true">
        {names.slice(0, SEEN_AVATARS).map((name, i) => (
          <span key={`${name}-${i}`} className="rounded-lg ring-2 ring-surface">
            <Avatar name={name} size="xs" />
          </span>
        ))}
      </span>
      <CheckCheckIcon className="text-primary" />
      {line}
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  grouped,
  mine,
  last = false,
}: Readonly<MessageItemProps>) {
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  const time = formatTime(message.createdAt);
  const nameOf = useNameOf();
  const name = nameOf(message.userId, message.userEmail);
  const sent = !message.status;
  const pressed = usePressed((s) => s.id === message.messageId);
  const setPressed = usePressed((s) => s.set);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const { offset, touchY, ref, handlers } = useMessageGestures({
    enabled: sent,
    onLongPress: () => setPressed(message.messageId),
    onSwipeRight: () => setReplyTo(message.channelId, snapshotOf(message)),
  });

  return (
    <div
      ref={ref}
      data-message-id={message.messageId}
      {...handlers}
      className={`group relative flex gap-3 px-4 transition-colors [touch-action:pan-y] [@media(hover:hover)]:hover:bg-surface-sidebar/70 [@media(hover:none)]:select-none [@media(hover:none)]:[-webkit-touch-callout:none] ${
        pressed ? "bg-surface-sidebar" : ""
      } ${grouped ? "py-0.5" : "pt-3 pb-0.5"} ${message.status === "pending" ? "opacity-60" : ""}`}
    >
      {offset > 0 && (
        <span
          aria-hidden="true"
          // At the finger's height: on a message taller than the screen the
          // middle may be off screen.
          className="absolute left-2 -translate-y-1/2 text-primary"
          style={{ top: touchY, opacity: Math.min(1, offset / 60) }}
        >
          <ReplyIcon />
        </span>
      )}
      <div
        className="flex min-w-0 flex-1 gap-3"
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        <div className="w-9 shrink-0">
          {grouped ? (
            <time
              className="invisible block pt-1.5 text-right text-[10px] text-ink-secondary group-hover:visible"
              title={message.isEdited ? "Edited" : undefined}
            >
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
              {message.isEdited && <EditedMark editedAt={message.editedAt} />}
            </div>
          )}

          {message.replyTo && <ReplyQuote reply={message.replyTo} />}

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

          {grouped && message.isEdited && <EditedMark editedAt={message.editedAt} />}

          {!message.status && <Reactions message={message} />}

          {mine && last && sent && isDmChannel(message.channelId) && (
            <ReadReceipt message={message} />
          )}
          {last && sent && !isDmChannel(message.channelId) && <ChannelSeenBy message={message} />}

          {message.status === "failed" && (
            <p className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-error" />
              <span>Not sent.</span>
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
      </div>

      {sent && <MessageActions message={message} pressed={pressed} mine={mine} />}
    </div>
  );
});
