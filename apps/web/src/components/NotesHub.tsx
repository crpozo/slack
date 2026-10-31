import {
  NOTES_CATEGORY_HINTS,
  NOTES_CATEGORY_LABELS,
  type Message,
  type NotesCategory,
} from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { dmPeer, formatDay, formatTime } from "../lib/channels";
import { notesApi } from "../lib/notesApi";
import {
  categoryCounts,
  fold,
  matchesNotesFilter,
  NO_FILTER,
  topTopics,
  unfiledCount,
  type NotesFilter,
} from "../lib/notesFilters";
import { useChat, useNameOf } from "../store";
import { useNotesHub } from "../store/notesHub";
import { AiNotesCard } from "./AiNotesCard";
import { Avatar } from "./Avatar";
import {
  ChevronRightIcon,
  CloseIcon,
  MenuIcon,
  RefreshIcon,
  SearchIcon,
  SparklesIcon,
} from "./icons";
import { UnreadAlertsDot } from "./NotificationBell";

/** Each category's colour: a dot and a tinted chip, the same everywhere. */
const CATEGORY_TONE: Record<NotesCategory, string> = {
  client: "bg-sky",
  project: "bg-primary",
  planning: "bg-warning",
  sales: "bg-[#c084fc]",
  support: "bg-error",
  technical: "bg-[#38bdf8]",
  team: "bg-success",
  other: "bg-ink-secondary",
};

const CHIP =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
const chipState = (active: boolean) =>
  active
    ? "border-primary bg-primary/20 text-ink"
    : "border-line text-ink-secondary hover:border-primary/50 hover:text-ink";

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
 * history. Phase 46: filter by category (filed by the AI as each card is
 * written; older ones on request with "Organize"), by topic and by words.
 */
export function NotesHub({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const nameOf = useNameOf();
  const { notes, status, error, nextCursor, loadingMore, load, loadMore } = useNotesHub();
  const showToast = useChat((s) => s.showToast);
  const [person, setPerson] = useState<string>("");
  const [filter, setFilter] = useState<NotesFilter>(NO_FILTER);
  const [classifying, setClassifying] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const patch = (next: Partial<NotesFilter>) => setFilter((f) => ({ ...f, ...next }));

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
  const withPerson = person ? notes.filter((m) => peerOf(m, myUserId) === person) : notes;
  const peerName = (m: Message) => {
    const peer = peerOf(m, myUserId);
    return peer ? nameOf(peer) : "";
  };
  // The topic chips follow the category picked; the category chips, everything else.
  const inCategory = withPerson.filter((m) =>
    matchesNotesFilter(m, { ...NO_FILTER, category: filter.category }),
  );
  const categories = categoryCounts(withPerson);
  const topics = topTopics(inCategory);
  const shown = withPerson.filter((m) => matchesNotesFilter(m, filter, peerName(m)));
  const filtering = filter.category !== "" || filter.topic !== "" || filter.query.trim() !== "";
  const unfiled = unfiledCount(notes);

  // Phase 46: files older notes a batch at a time; each card updates live as it's filed.
  async function classifyOlder() {
    setClassifying(true);
    try {
      for (let round = 0; round < 40; round++) {
        const { classified, remaining } = await notesApi.classify();
        if (remaining === 0 || classified === 0) break;
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't organize the notes.");
    } finally {
      setClassifying(false);
    }
  }

  const days: Array<{ day: string; items: Message[] }> = [];
  for (const message of shown) {
    const day = formatDay(message.createdAt);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(message);
    else days.push({ day, items: [message] });
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-surface">
      {/* Desktop (Phase 37b): glass, floating over the content that scrolls under it. */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4 md:glass md:absolute md:inset-x-0 md:top-0 md:z-20 md:border-white/10">
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
            className="input !w-auto max-w-[40%] py-1.5 text-sm"
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

      <div className="min-h-0 flex-1 overflow-y-auto md:pt-14">
        <div className="mx-auto w-full max-w-2xl px-3 pb-8 sm:px-4">
          {notes.length > 0 && (
            <div className="flex flex-col gap-3 pt-4" data-notes-filters>
              <label className="relative block">
                <span className="sr-only">Search notes</span>
                <SearchIcon
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={filter.query}
                  onChange={(e) => patch({ query: e.target.value })}
                  placeholder="Search summaries, topics and people"
                  className="input py-2 pl-9 text-sm"
                />
              </label>

              {(categories.length > 0 || unfiled > 0) && (
                <div
                  className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
                  role="group"
                  aria-label="Categories"
                >
                  <button
                    type="button"
                    onClick={() => patch({ category: "", topic: "" })}
                    aria-pressed={filter.category === ""}
                    className={`${CHIP} ${chipState(filter.category === "")}`}
                  >
                    All <span className="tabular-nums opacity-70">{withPerson.length}</span>
                  </button>
                  {categories.map(({ category, count }) => (
                    <button
                      key={category}
                      type="button"
                      onClick={() =>
                        patch({ category: filter.category === category ? "" : category, topic: "" })
                      }
                      aria-pressed={filter.category === category}
                      title={NOTES_CATEGORY_HINTS[category]}
                      className={`${CHIP} ${chipState(filter.category === category)}`}
                      data-category={category}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${CATEGORY_TONE[category]}`}
                        aria-hidden="true"
                      />
                      {NOTES_CATEGORY_LABELS[category]}
                      <span className="tabular-nums opacity-70">{count}</span>
                    </button>
                  ))}
                  {unfiled > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          category: filter.category === "unfiled" ? "" : "unfiled",
                          topic: "",
                        })
                      }
                      aria-pressed={filter.category === "unfiled"}
                      className={`${CHIP} ${chipState(filter.category === "unfiled")}`}
                    >
                      Unsorted <span className="tabular-nums opacity-70">{unfiled}</span>
                    </button>
                  )}
                </div>
              )}

              {topics.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label="Topics"
                >
                  <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                    Topics
                  </span>
                  {topics.map(({ topic, count }) => {
                    const active = fold(filter.topic) === fold(topic);
                    return (
                      <button
                        key={topic}
                        type="button"
                        onClick={() => patch({ topic: active ? "" : topic })}
                        aria-pressed={active}
                        className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
                          active
                            ? "border-primary bg-primary/20 text-ink"
                            : "border-transparent bg-surface-sidebar text-ink-secondary hover:text-ink"
                        }`}
                      >
                        #{topic}
                        {count > 1 && <span className="ml-1 tabular-nums opacity-60">{count}</span>}
                      </button>
                    );
                  })}
                </div>
              )}

              {unfiled > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/[0.08] px-3 py-2.5 text-sm text-ink/85">
                  <SparklesIcon className="shrink-0 text-primary" aria-hidden="true" />
                  <p className="min-w-0 flex-1">
                    {unfiled === 1
                      ? "1 older note has no category yet."
                      : `${unfiled} older notes have no category yet.`}{" "}
                    AI can sort them by category and topic.
                  </p>
                  <button
                    type="button"
                    onClick={() => void classifyOlder()}
                    disabled={classifying}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-primary/50 px-3 py-1 text-xs font-semibold text-ink hover:bg-primary/15 disabled:opacity-60"
                  >
                    <RefreshIcon className={classifying ? "animate-spin" : ""} aria-hidden="true" />
                    {classifying ? "Organizing…" : "Organize"}
                  </button>
                </div>
              )}

              {filtering && (
                <p className="flex items-center gap-2 text-xs text-ink-secondary" role="status">
                  {shown.length === 1 ? "1 note" : `${shown.length} notes`} match
                  <button
                    type="button"
                    onClick={() => setFilter(NO_FILTER)}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-hover hover:text-ink"
                  >
                    <CloseIcon aria-hidden="true" /> Clear filters
                  </button>
                </p>
              )}
            </div>
          )}
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
                          {message.aiNotes?.category && (
                            <button
                              type="button"
                              onClick={() =>
                                patch({ category: message.aiNotes!.category!, topic: "" })
                              }
                              title={`Show ${NOTES_CATEGORY_LABELS[message.aiNotes.category].toLowerCase()} notes`}
                              className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-ink-secondary hover:text-ink sm:inline-flex"
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${CATEGORY_TONE[message.aiNotes.category]}`}
                                aria-hidden="true"
                              />
                              {NOTES_CATEGORY_LABELS[message.aiNotes.category]}
                            </button>
                          )}
                          <Link
                            to={`/app/${encodeURIComponent(message.channelId)}`}
                            className="flex shrink-0 items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
                          >
                            Open conversation
                            <ChevronRightIcon aria-hidden="true" />
                          </Link>
                        </div>
                        {(message.aiNotes?.topics?.length ?? 0) > 0 && (
                          <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Topics">
                            {message.aiNotes!.topics!.map((topic) => (
                              <li key={topic}>
                                <button
                                  type="button"
                                  onClick={() => patch({ topic })}
                                  className="rounded-md bg-surface-sidebar px-1.5 py-0.5 text-[11px] text-ink-secondary hover:text-ink"
                                >
                                  #{topic}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <AiNotesCard message={message} mine={message.userId === myUserId} />
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {status === "ready" && notes.length > 0 && shown.length === 0 && (
            <p className="pt-10 text-center text-sm text-ink-secondary">
              {filtering
                ? "No notes loaded so far match. Older ones load as you scroll."
                : person
                  ? `No notes with ${nameOf(person)} loaded yet.`
                  : "No notes."}
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
