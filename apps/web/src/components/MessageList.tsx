import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { chat } from "../lib/chat";
import { formatDay } from "../lib/channels";
import { useChat, type ChatMessage } from "../store";
import { isGroupedWith } from "../store/messages";
import { ArrowDownIcon } from "./icons";
import { MessageItem } from "./MessageItem";

const EMPTY: ChatMessage[] = [];
const BOTTOM_THRESHOLD_PX = 80;

interface Anchor {
  id: string;
  offset: number;
}

export function MessageList({ channelId, title }: { channelId: string; title: string }) {
  const messages = useChat((s) => s.messagesByChannel[channelId] ?? EMPTY);
  const loaded = useChat((s) => channelId in s.cursors);
  const cursor = useChat((s) => s.cursors[channelId]);
  const loadingOlder = useChat((s) => s.historyRequests[channelId] === "older");
  const myUserId = useChat((s) => s.me?.userId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const previous = useRef<{ channelId: string; first?: string; last?: string } | null>(null);
  const [showNewPill, setShowNewPill] = useState(false);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowNewPill(false);
  };

  // Keep the viewport stable: bottom on open, anchored on prepend, follow on append.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = messages[0]?.messageId;
    const last = messages.at(-1)?.messageId;
    const prev = previous.current;

    if (!prev || prev.channelId !== channelId || !prev.last) {
      scrollToBottom();
    } else if (first !== prev.first && anchor.current) {
      const node = el.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchor.current.id)}"]`,
      );
      if (node) el.scrollTop = node.offsetTop - anchor.current.offset;
      anchor.current = null;
    } else if (last !== prev.last) {
      if (atBottom.current || messages.at(-1)?.userId === myUserId) scrollToBottom();
      else setShowNewPill(true);
    }
    previous.current = { channelId, first, last };
  }, [messages, channelId, myUserId]);

  // Images loading at the bottom grow the content: stay pinned if we were.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Infinite scroll upwards.
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !cursor || loadingOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        const firstNode = root.querySelector<HTMLElement>("[data-message-id]");
        if (firstNode?.dataset.messageId) {
          anchor.current = {
            id: firstNode.dataset.messageId,
            offset: firstNode.offsetTop - root.scrollTop,
          };
        }
        chat.loadHistory(channelId, "older");
      },
      { root, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [channelId, cursor, loadingOlder]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    if (atBottom.current) setShowNewPill(false);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain"
        role="log"
        aria-live="polite"
        aria-label={`Mensajes de ${title}`}
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-3">
          <div ref={sentinelRef} />

          {loadingOlder && (
            <p className="py-3 text-center text-xs text-ink-secondary">
              Cargando mensajes anteriores…
            </p>
          )}

          {loaded && cursor === null && (
            <div className="px-4 pb-2 pt-8">
              <p className="text-lg font-semibold text-ink">{title}</p>
              <p className="text-sm text-ink-secondary">
                {messages.length
                  ? "Este es el inicio de la conversación."
                  : "Aún no hay mensajes. ¡Escribe el primero!"}
              </p>
            </div>
          )}

          {!loaded && (
            <div className="space-y-4 px-4 py-6" aria-label="Cargando mensajes">
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

          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay =
              !prev ||
              new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return (
              <div key={m.messageId}>
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
                />
              </div>
            );
          })}
        </div>
      </div>

      {showNewPill && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-sky px-3 py-1.5 text-xs font-semibold text-ink shadow-md hover:brightness-95"
        >
          <ArrowDownIcon /> Mensajes nuevos
        </button>
      )}
    </div>
  );
}
