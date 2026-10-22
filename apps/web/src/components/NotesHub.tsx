import type { Message } from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { dmPeer, formatDay, formatTime } from "../lib/channels";
import { useChat, useNameOf } from "../store";
import { useNotesHub } from "../store/notesHub";
import { AiNotesCard } from "./AiNotesCard";
import { Avatar } from "./Avatar";
import { ChevronRightIcon, MenuIcon, SparklesIcon } from "./icons";
import { UnreadAlertsDot } from "./NotificationBell";

/** Who a notes card is "with", from your side: the other person of its DM. */
function peerOf(message: Message, myUserId: string): string | null {
  return (
    dmPeer(message.channelId, myUserId) ??
    message.aiNotes?.participants.find((id) => id !== myUserId) ??
    null
  );
}

/**
 * The AI Notes hub (`/app/notes`, Phase 29): every ✨ notes card from the
 * conversations you're in, newest first and grouped by day, each with a way
 * back to its conversation. Older pages load as you scroll; new cards and
 * their updates arrive live. Filter by person to find one relationship's
 * history.
 */
export function NotesHub({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const nameOf = useNameOf();
  const { notes, status, error, nextCursor, loadingMore, load, loadMore } = useNotesHub();
  const [person, setPerson] = useState<string>("");
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (useNotesHub.getState().status === "idle") void load();
  }, [load]);

  // Near the bottom: the next page.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !nextCursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && void loadMore(),
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore, notes.length]);

  const myUserId = me?.userId ?? "";
  const people = useMemo(() => {
    const ids = new Set(notes.map((m) => peerOf(m, myUserId)).filter((id) => id !== null));
    return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }, [notes, myUserId, nameOf]);
  const shown = person ? notes.filter((m) => peerOf(m, myUserId) === person) : notes;
  const days: Array<{ day: string; items: Message[] }> = [];
  for (const message of shown) {
    const day = formatDay(message.createdAt);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(message);
    else days.push({ day, items: [message] });
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        {onOpenSidebar && (
          <button
            type="button"
            onClick={onOpenSidebar}
            className="relative rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
            aria-label="Open menu"
          >
            <MenuIcon />
            <UnreadAlertsDot />
          </button>
        )}
        <SparklesIcon className="text-xl text-primary" aria-hidden="true" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-ink">AI Notes</h1>
        {people.length > 1 && (
          <select
            aria-label="Show notes with"
            className="input !w-auto max-w-[45%] py-1.5 text-sm"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          >
            <option value="">Everyone</option>
            {people.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-3 pb-8 sm:px-0">
          {status === "loading" && notes.length === 0 && (
            <div className="space-y-3 pt-6" aria-busy="true" aria-label="Loading notes">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface-sidebar" />
              ))}
            </div>
          )}

          {status === "error" && (
            <div role="alert" className="pt-10 text-center">
              <p className="text-sm text-ink">{error ?? "Couldn't load the notes."}</p>
              <button type="button" onClick={() => void load()} className="btn-primary mt-3">
                Try again
              </button>
            </div>
          )}

          {status === "ready" && notes.length === 0 && (
            <div className="mx-auto max-w-sm pt-16 text-center">
              <SparklesIcon className="mx-auto text-4xl text-primary" aria-hidden="true" />
              <h2 className="mt-3 text-base font-semibold text-ink">No AI notes yet</h2>
              <p className="mt-1 text-sm text-ink-secondary">
                Turn on ✨ AI notes during a call in a direct message. When the call ends, its
                summary and action items appear here and in the conversation.
              </p>
            </div>
          )}

          {days.map(({ day, items }) => (
            <section key={day} aria-label={day}>
              <h2 className="sticky top-0 z-10 bg-surface/95 py-3 text-xs font-semibold uppercase tracking-wide text-ink-secondary backdrop-blur">
                {day}
              </h2>
              <ul className="space-y-5">
                {items.map((message) => {
                  const peer = peerOf(message, myUserId);
                  const name = peer ? nameOf(peer) : "a call";
                  return (
                    <li key={`${message.channelId}|${message.sk}`} data-hub-note={message.sk}>
                      <article aria-label={`Call with ${name}`}>
                        <div className="flex items-center gap-2 text-sm">
                          <Avatar name={name} size="sm" />
                          <p className="min-w-0 flex-1 truncate">
                            <span className="font-semibold text-ink">Call with {name}</span>{" "}
                            <time
                              className="text-xs text-ink-secondary"
                              dateTime={new Date(message.createdAt).toISOString()}
                            >
                              {formatTime(message.createdAt)}
                            </time>
                          </p>
                          <Link
                            to={`/app/${encodeURIComponent(message.channelId)}`}
                            className="flex shrink-0 items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
                          >
                            Open conversation
                            <ChevronRightIcon aria-hidden="true" />
                          </Link>
                        </div>
                        <AiNotesCard message={message} mine={message.userId === myUserId} />
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {status === "ready" && person && shown.length === 0 && (
            <p className="pt-10 text-center text-sm text-ink-secondary">
              No notes with {nameOf(person)} loaded yet.
            </p>
          )}

          <div ref={sentinel} />
          {nextCursor && status === "ready" && (
            <div className="pt-6 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                {loadingMore ? "Loading…" : "Load older notes"}
              </button>
            </div>
          )}
          {error && status === "ready" && (
            <p role="alert" className="pt-3 text-center text-sm text-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
