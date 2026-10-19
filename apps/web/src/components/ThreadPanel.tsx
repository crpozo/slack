import { useEffect, useLayoutEffect, useRef } from "react";
import { chat } from "../lib/chat";
import { useChat, type ChatMessage } from "../store";
import { isGroupedWith } from "../store/messages";
import { Composer } from "./Composer";
import { ArrowDownIcon, CloseIcon } from "./icons";
import { MessageItem } from "./MessageItem";

const EMPTY: ChatMessage[] = [];

/**
 * A message's thread: the parent on top, its replies below (oldest first,
 * older pages on scroll-up), and a composer that posts into the thread.
 * On desktop it sits beside the conversation; on phones it's a screen of its
 * own with a back button (`onClose` either way).
 */
export function ThreadPanel({
  channelId,
  parent,
  onClose,
  readOnly = false,
}: Readonly<{
  channelId: string;
  parent: ChatMessage;
  onClose: () => void;
  /** Archived channel: no composer. */
  readOnly?: boolean;
}>) {
  const replies = useChat((s) => s.threads[parent.sk] ?? EMPTY);
  const loaded = useChat((s) => parent.sk in s.threadCursors);
  const cursor = useChat((s) => s.threadCursors[parent.sk]);
  const loading = useChat((s) => s.threadRequests[parent.sk]);
  const myUserId = useChat((s) => s.me?.userId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  // Load on open; the replies that arrive while it's open count as seen.
  useEffect(() => {
    chat.setActiveThread(parent.sk);
    chat.loadThread(channelId, parent, "initial");
    return () => chat.setActiveThread(null);
  }, [channelId, parent]);

  // Start at the newest reply; follow new ones.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (replies.length !== lastCount.current) {
      el.scrollTop = el.scrollHeight;
      lastCount.current = replies.length;
    }
  }, [replies.length]);

  // Older replies when scrolled to the top.
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !cursor || loading) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) chat.loadThread(channelId, parent, "older");
      },
      { root, rootMargin: "120px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [channelId, parent, cursor, loading]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Thread">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Back"
        >
          <ArrowDownIcon className="rotate-90" />
        </button>
        <h2 className="min-w-0 flex-1 truncate font-semibold text-ink">Thread</h2>
        <button
          type="button"
          onClick={onClose}
          className="hidden rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:block"
          aria-label="Close thread"
        >
          <CloseIcon />
        </button>
      </header>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3"
        role="log"
        aria-label="Thread replies"
      >
        <div className="border-b border-line pb-2">
          <MessageItem message={parent} grouped={false} mine={parent.userId === myUserId} />
        </div>
        <div ref={sentinelRef} className="h-px" aria-hidden="true" />
        {loading === "older" && (
          <p className="py-2 text-center text-xs text-ink-secondary">Loading earlier replies…</p>
        )}
        {!loaded && replies.length === 0 && (
          <p className="py-6 text-center text-xs text-ink-secondary">Loading replies…</p>
        )}
        {loaded && replies.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-ink-secondary">
            No replies yet. Start the thread below.
          </p>
        )}
        {replies.map((m, i) => (
          <MessageItem
            key={m.messageId}
            message={m}
            grouped={isGroupedWith(replies[i - 1], m)}
            mine={m.userId === myUserId}
          />
        ))}
      </div>
      {readOnly ? (
        <p className="border-t border-line px-4 py-3 text-center text-sm text-ink-secondary">
          This channel is archived.
        </p>
      ) : (
        <Composer
          key={parent.sk}
          channelId={channelId}
          thread={{ messageId: parent.messageId, sk: parent.sk }}
          placeholder="Reply in thread"
        />
      )}
    </section>
  );
}
