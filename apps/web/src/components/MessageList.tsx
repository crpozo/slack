import { isExpired } from "@mindfultech/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chat } from "../lib/chat";
import { formatDay } from "../lib/channels";
import { useChat, type ChatMessage } from "../store";
import { isGroupedWith } from "../store/messages";
import { ArrowDownIcon } from "./icons";
import { MessageItem } from "./MessageItem";

const EMPTY: ChatMessage[] = [];
const BOTTOM_THRESHOLD_PX = 80;
/** A typical one-line message with its padding; rows are measured as soon as they render. */
const ESTIMATED_ROW_PX = 56;
/** Rows kept rendered beyond the viewport, each side. */
const OVERSCAN = 8;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * The conversation, virtualized: only the rows around the viewport exist in
 * the DOM, however long the session gets. The virtualizer anchors to the end
 * (new messages keep the list pinned to the bottom when it was there) and
 * keeps the viewport still when older pages are prepended above it or a row
 * changes height (an image loading). Rows are measured, never guessed twice.
 */
export function MessageList({
  channelId,
  title,
  onOpenThread,
}: Readonly<{
  channelId: string;
  title: string;
  /** "Reply in thread" / "N replies": opens the thread of that message. */
  onOpenThread?: (message: ChatMessage) => void;
}>) {
  const stored = useChat((s) => s.messagesByChannel[channelId] ?? EMPTY);
  // Secrets vanish at their TTL, even in an open conversation: `now` moves once a minute
  // while one is on screen, and the list is filtered against it.
  const hasSecrets = stored.some((m) => m.expiresAt !== undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasSecrets) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [hasSecrets]);
  const messages = useMemo(
    () => (hasSecrets ? stored.filter((m) => !isExpired(m, now)) : stored),
    [stored, hasSecrets, now],
  );
  const loaded = useChat((s) => channelId in s.cursors);
  const cursor = useChat((s) => s.cursors[channelId]);
  const loadingOlder = useChat((s) => s.historyRequests[channelId] === "older");
  const myUserId = useChat((s) => s.me?.userId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const previous = useRef<{ channelId: string; last?: string } | null>(null);
  const [showNewPill, setShowNewPill] = useState(false);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: OVERSCAN,
    getItemKey: (index) => messages[index]?.messageId ?? index,
    // Chat semantics: stay at the end when we're there, hold still otherwise.
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: BOTTOM_THRESHOLD_PX,
  });

  const setListAtBottom = useChat((s) => s.setListAtBottom);
  const setAtBottom = useCallback(
    (value: boolean) => {
      atBottom.current = value;
      setListAtBottom(value);
      // Scrolled down to the newest messages: they count as read now.
      if (value) chat.sendReadMark(channelId);
    },
    [channelId, setListAtBottom],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setShowNewPill(false);
  }, [setAtBottom]);

  // Rows are estimated until rendered and measured, and images grow once they
  // load: while we mean to be at the bottom, every change of the list's height
  // re-pins it there (the first open takes a couple of passes to settle).
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [totalSize]);

  // Bottom on open; on append, follow when we were there (or it's ours), else offer the pill.
  // Prepends (older pages) need nothing: the virtualizer re-anchors on the row we were at.
  //
  // Opening a conversation takes two passes: this layout effect pins before paint
  // with estimated row heights, and the frame after, once the rows are measured
  // (so the height can be final with no `totalSize` change to re-pin on, e.g. a
  // cached history that was already measured), pins again and only then tells
  // the server we've read the newest message: it is on screen by then.
  useLayoutEffect(() => {
    const last = messages.at(-1)?.messageId;
    const prev = previous.current;
    const opened = prev?.channelId !== channelId || !prev.last;
    if (opened) {
      if (messages.length > 0) scrollToBottom();
    } else if (last !== prev.last) {
      if (atBottom.current || messages.at(-1)?.userId === myUserId) scrollToBottom();
      else setShowNewPill(true);
    }
    previous.current = { channelId, last };
    if (!opened || messages.length === 0) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el || !atBottom.current) return;
        el.scrollTop = el.scrollHeight;
        chat.viewed(channelId);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, channelId, myUserId, scrollToBottom]);

  // Infinite scroll upwards: the sentinel sits at the very top of the list's full height.
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !cursor || loadingOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) chat.loadHistory(channelId, "older");
      },
      { root, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [channelId, cursor, loadingOlder]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nowAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    if (nowAtBottom !== atBottom.current) setAtBottom(nowAtBottom);
    if (nowAtBottom) setShowNewPill(false);
  }

  const topContent = (
    <>
      {loadingOlder && (
        <p className="py-3 text-center text-xs text-ink-secondary">Loading earlier messages…</p>
      )}
      {loaded && cursor === null && (
        <div className="px-4 pb-2 pt-8">
          <p className="text-lg font-semibold text-ink">{title}</p>
          <p className="text-sm text-ink-secondary">
            {messages.length
              ? "This is the start of the conversation."
              : "No messages yet. Be the first to write!"}
          </p>
        </div>
      )}
    </>
  );

  const rows = virtualizer.getVirtualItems();

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // overflow-x hidden: a row sliding right (swipe to reply) must not give the
        // list a horizontal scrollbar to scroll instead of the row. The virtualizer
        // owns scroll anchoring, so the browser's is off.
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]"
        role="log"
        aria-live="polite"
        aria-label={`Messages in ${title}`}
      >
        <div className="flex min-h-full flex-col justify-end pb-3">
          {!loaded && (
            <div className="space-y-4 px-4 py-6" aria-label="Loading messages">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <div className="h-9 w-9 animate-pulse rounded-lg bg-surface-hover" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-24 animate-pulse rounded bg-surface-hover" />
                    <div className="h-8 w-2/3 animate-pulse rounded-2xl bg-surface-hover" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {messages.length === 0 && topContent}

          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            <div ref={sentinelRef} className="absolute top-0 h-px w-full" aria-hidden="true" />
            {rows.map((row) => {
              const m = messages[row.index]!;
              const prev = messages[row.index - 1];
              const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {row.index === 0 && topContent}
                  {newDay && (
                    <div className="my-2 flex items-center gap-3 px-4" role="separator">
                      <div className="h-px flex-1 bg-line" />
                      <span className="text-xs font-medium text-ink-secondary">
                        {formatDay(m.createdAt)}
                      </span>
                      <div className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <MessageItem
                    message={m}
                    grouped={!newDay && isGroupedWith(prev, m)}
                    mine={m.userId === myUserId}
                    last={row.index === messages.length - 1}
                    onOpenThread={onOpenThread}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {showNewPill && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-sky px-3 py-1.5 text-xs font-semibold text-on-accent shadow-md hover:brightness-95"
        >
          <ArrowDownIcon /> New messages
        </button>
      )}
    </div>
  );
}
