import {
  extractActionItems,
  foldMeetingTopic,
  NOTES_CATEGORY_HINTS,
  NOTES_CATEGORY_LABELS,
  type Message,
  type NotesCategory,
} from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatCallDuration } from "../lib/call";
import { Link } from "react-router-dom";
import { dmPeer, formatDay, formatTime } from "../lib/channels";
import { notesApi } from "../lib/notesApi";
import {
  categoryCounts,
  fold,
  groupByNoteDate,
  matchesNotesFilter,
  NO_FILTER,
  notePreview,
  noteTitle,
  noteWhen,
  topTopics,
  unfiledCount,
  type NotesFilter,
} from "../lib/notesFilters";
import { useChat, useNameOf } from "../store";
import { useNotesHub } from "../store/notesHub";
import { AiNotesCard } from "./AiNotesCard";
import { Avatar } from "./Avatar";
import {
  CheckCircleIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  KanbanIcon,
  MenuIcon,
  MicIcon,
  RefreshIcon,
  SearchIcon,
  SparklesIcon,
} from "./icons";
import { useModalDialog } from "./Modal";
import { NoteTopicPicker } from "./NoteTopicPicker";
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
 * Phase 48: the whole width: filters in a column on the left, each meeting a
 * compact card (its AI title, category, preview, topics, action items) in a
 * grid, the full notes in a side panel.
 */
export function NotesHub({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const nameOf = useNameOf();
  const {
    notes,
    status,
    error,
    nextCursor,
    loadingMore,
    load,
    loadMore,
    topic: meetingTopic,
    topics: meetingTopics,
    showTopic,
  } = useNotesHub();
  const showToast = useChat((s) => s.showToast);
  const [person, setPerson] = useState<string>("");
  const [filter, setFilter] = useState<NotesFilter>(NO_FILTER);
  const [classifying, setClassifying] = useState(false);
  /** The card open in the side panel (`channelId|sk`). */
  const [openKey, setOpenKey] = useState<string | null>(null);
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

  // Phase 50: "Hoy", "Ayer", "Esta semana", then month by month.
  const groups = groupByNoteDate(shown, (m) => m.createdAt);
  const pickTopic = (topic: string | null) => {
    setOpenKey(null);
    void showTopic(
      topic && meetingTopic && foldMeetingTopic(topic) === foldMeetingTopic(meetingTopic)
        ? null
        : topic,
    );
  };

  const keyOf = (m: Message) => `${m.channelId}|${m.sk}`;
  const opened = openKey ? notes.find((m) => keyOf(m) === openKey) : undefined;

  const categoryChips = (vertical: boolean) => (
    <div
      className={
        vertical
          ? "flex flex-col gap-0.5"
          : "-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
      }
      role="group"
      aria-label="Categories"
    >
      <CategoryButton
        vertical={vertical}
        active={filter.category === ""}
        onClick={() => patch({ category: "", topic: "" })}
        label="All notes"
        count={withPerson.length}
      />
      {categories.map(({ category, count }) => (
        <CategoryButton
          key={category}
          vertical={vertical}
          active={filter.category === category}
          onClick={() =>
            patch({ category: filter.category === category ? "" : category, topic: "" })
          }
          label={NOTES_CATEGORY_LABELS[category]}
          hint={NOTES_CATEGORY_HINTS[category]}
          tone={CATEGORY_TONE[category]}
          count={count}
          dataCategory={category}
        />
      ))}
      {unfiled > 0 && (
        <CategoryButton
          vertical={vertical}
          active={filter.category === "unfiled"}
          onClick={() =>
            patch({ category: filter.category === "unfiled" ? "" : "unfiled", topic: "" })
          }
          label="Unsorted"
          count={unfiled}
        />
      )}
    </div>
  );

  const topicChips = topics.length > 0 && (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
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
  );

  // Phase 50: the meeting topics people filed their notes under, from the server.
  const topicNav = (vertical: boolean) =>
    (meetingTopics.length > 0 || meetingTopic) && (
      <div
        className={
          vertical
            ? "flex flex-col gap-0.5"
            : "-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
        }
        role="group"
        aria-label="Meeting topics"
        data-meeting-topics
      >
        <TopicButton
          vertical={vertical}
          active={!meetingTopic}
          onClick={() => pickTopic(null)}
          label="All meetings"
        />
        {meetingTopics.map(({ topic, count }) => (
          <TopicButton
            key={topic}
            vertical={vertical}
            active={!!meetingTopic && foldMeetingTopic(topic) === foldMeetingTopic(meetingTopic)}
            onClick={() => pickTopic(topic)}
            label={topic}
            count={count}
          />
        ))}
      </div>
    );

  const search = (
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
  );

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface">
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
        <div className="mx-auto w-full max-w-[1600px] px-3 pb-10 pt-4 sm:px-6 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-8 lg:pt-6">
          {(notes.length > 0 || meetingTopic) && (
            <aside className="hidden lg:block" aria-label="Filters" data-notes-filters="sidebar">
              <div className="sticky top-6 flex flex-col gap-5">
                {search}
                {topicNav(true) && (
                  <div className="flex flex-col gap-2">
                    <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                      Meeting topics
                    </h2>
                    {topicNav(true)}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                    Categories
                  </h2>
                  {categoryChips(true)}
                </div>
                {topicChips && (
                  <div className="flex flex-col gap-2">
                    <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                      AI tags
                    </h2>
                    <div className="px-1">{topicChips}</div>
                  </div>
                )}
              </div>
            </aside>
          )}

          <main className="min-w-0">
            {(notes.length > 0 || meetingTopic) && (
              <div className="mb-4 flex flex-col gap-3 lg:hidden" data-notes-filters="top">
                {search}
                {topicNav(false)}
                {categoryChips(false)}
                {topicChips}
              </div>
            )}

            {unfiled > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/[0.08] px-4 py-3 text-sm text-ink/85">
                <SparklesIcon className="shrink-0 text-primary" aria-hidden="true" />
                <p className="min-w-0 flex-1">
                  {unfiled === 1
                    ? "1 note is missing its title or category."
                    : `${unfiled} notes are missing their title or category.`}{" "}
                  AI can fill them in from each summary.
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

            {meetingTopic && (
              <p
                className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink"
                role="status"
                data-topic-filter
              >
                <FolderIcon className="text-primary" aria-hidden="true" />
                <span className="font-semibold">{meetingTopic}</span>
                <span className="text-xs text-ink-secondary">
                  {status === "ready" &&
                    (nextCursor
                      ? `${notes.length}+ meetings`
                      : `${notes.length} ${notes.length === 1 ? "meeting" : "meetings"}`)}
                </span>
                <button
                  type="button"
                  onClick={() => pickTopic(null)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-secondary hover:bg-surface-hover hover:text-ink"
                >
                  <CloseIcon aria-hidden="true" /> All meetings
                </button>
              </p>
            )}

            {filtering && (
              <p className="mb-3 flex items-center gap-2 text-xs text-ink-secondary" role="status">
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

            {status === "loading" && notes.length === 0 && (
              <div
                className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3"
                aria-busy="true"
                aria-label="Loading notes"
              >
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-52 animate-pulse rounded-2xl bg-surface-sidebar" />
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

            {status === "ready" && notes.length === 0 && meetingTopic && (
              <p className="pt-10 text-center text-sm text-ink-secondary">
                No meetings filed under {meetingTopic}.
              </p>
            )}

            {status === "ready" && notes.length === 0 && !meetingTopic && (
              <div className="mx-auto max-w-sm pt-16 text-center">
                <SparklesIcon className="mx-auto text-4xl text-primary" aria-hidden="true" />
                <h2 className="mt-3 text-base font-semibold text-ink">No AI notes yet</h2>
                <p className="mt-1 text-sm text-ink-secondary">
                  Turn on ✨ AI notes during a call in a direct message. When the call ends, its
                  summary and action items appear here and in the conversation.
                </p>
              </div>
            )}

            {groups.map(({ key, label, items }) => (
              <section key={key} aria-label={label} className="mb-6" data-date-group={key}>
                <h2 className="sticky top-0 z-10 -mx-1 flex items-baseline gap-2 bg-surface/95 px-1 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary backdrop-blur">
                  {label}
                  <span className="font-normal normal-case tracking-normal opacity-70">
                    {items.length}
                  </span>
                </h2>
                <ul className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                  {items.map((message) => (
                    <li key={keyOf(message)} className="flex" data-hub-note={message.sk}>
                      <MeetingCard
                        message={message}
                        peerName={peerName(message)}
                        onOpen={() => setOpenKey(keyOf(message))}
                        onCategory={(category) => patch({ category, topic: "" })}
                        onTopic={(topic) => patch({ topic })}
                        onMeetingTopic={pickTopic}
                      />
                    </li>
                  ))}
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
          </main>
        </div>
      </div>

      {opened && (
        <NoteDrawer
          message={opened}
          title={noteTitle(opened, peerName(opened))}
          peerName={peerName(opened)}
          mine={opened.userId === myUserId}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}

/** A meeting topic in the hub's filters: a row in the side column, a chip on top. */
function TopicButton({
  vertical,
  active,
  onClick,
  label,
  count,
}: Readonly<{
  vertical: boolean;
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}>) {
  if (vertical) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
          active
            ? "bg-primary/20 font-semibold text-ink"
            : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
        }`}
      >
        <FolderIcon className="shrink-0 text-[13px]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && <span className="tabular-nums text-xs opacity-70">{count}</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${CHIP} ${chipState(active)}`}
    >
      <FolderIcon aria-hidden="true" />
      {label}
      {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

function CategoryButton({
  vertical,
  active,
  onClick,
  label,
  count,
  hint,
  tone,
  dataCategory,
}: Readonly<{
  vertical: boolean;
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  hint?: string;
  tone?: string;
  dataCategory?: string;
}>) {
  const dot = tone && (
    <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
  );
  if (vertical) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={hint}
        data-category={dataCategory}
        className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
          active
            ? "bg-primary/20 font-semibold text-ink"
            : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
        }`}
      >
        {dot ?? <span className="h-2 w-2 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="tabular-nums text-xs opacity-70">{count}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      data-category={dataCategory}
      className={`${CHIP} ${chipState(active)}`}
    >
      {dot}
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

/**
 * One meeting as a card: category and when, the AI's title, the opening of
 * the summary, a few topics, and what came out of it (action items, a
 * recording, tasks sent to a board). The whole card opens the full notes.
 */
function MeetingCard({
  message,
  peerName,
  onOpen,
  onCategory,
  onTopic,
  onMeetingTopic,
}: Readonly<{
  message: Message;
  peerName: string;
  onOpen: () => void;
  onCategory: (category: NotesCategory) => void;
  onTopic: (topic: string) => void;
  onMeetingTopic: (topic: string) => void;
}>) {
  const notes = message.aiNotes!;
  const title = noteTitle(message, peerName);
  const preview = notes.status === "ready" ? notePreview(notes.summary) : "";
  const actions = notes.status === "ready" ? extractActionItems(notes.summary).length : 0;
  const topics = notes.topics ?? [];
  const extra = topics.length - 3;
  let body: ReactNode;
  if (notes.status === "pending") {
    body = (
      <div className="space-y-2" aria-label="Generating the notes">
        <p className="text-sm text-ink-secondary">Writing the notes…</p>
        <div className="h-3 w-11/12 animate-pulse rounded bg-surface-hover" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-surface-hover" />
      </div>
    );
  } else if (notes.status === "failed") {
    body = (
      <p className="text-sm text-ink-secondary">
        {notes.error ?? "The notes couldn't be written."}
      </p>
    );
  } else {
    body = (
      <p className="line-clamp-4 text-sm leading-relaxed text-ink-secondary [text-wrap:pretty]">
        {preview}
      </p>
    );
  }
  return (
    <article
      className="group relative flex w-full flex-col gap-3 rounded-2xl border border-line bg-surface-sidebar p-4 transition duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg focus-within:border-primary/60"
      data-meeting-card={notes.callId}
      data-status={notes.status}
    >
      <div className="flex items-center gap-2 text-xs text-ink-secondary">
        {notes.category ? (
          <button
            type="button"
            onClick={() => onCategory(notes.category!)}
            className="relative z-10 inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-medium hover:border-primary/50 hover:text-ink"
            title={`Show ${NOTES_CATEGORY_LABELS[notes.category].toLowerCase()} notes`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${CATEGORY_TONE[notes.category]}`}
              aria-hidden="true"
            />
            {NOTES_CATEGORY_LABELS[notes.category]}
          </button>
        ) : notes.status === "ready" ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line px-2 py-0.5">
            Unsorted
          </span>
        ) : null}
        {notes.topic && (
          <button
            type="button"
            onClick={() => onMeetingTopic(notes.topic!)}
            className="relative z-10 inline-flex min-w-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-medium text-ink hover:bg-primary/25"
            title={`Show the meetings filed under ${notes.topic}`}
            data-card-topic
          >
            <FolderIcon className="shrink-0" aria-hidden="true" />
            <span className="truncate">{notes.topic}</span>
          </button>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {noteWhen(message.createdAt, formatTime)}
          </time>{" "}
          · {formatCallDuration(notes.endedAt - notes.startedAt)}
        </span>
      </div>

      <h3 className="text-base font-bold leading-snug text-ink [text-wrap:pretty]">
        {/* The title's button stretches over the whole card: one big target to open it. */}
        <button
          type="button"
          onClick={onOpen}
          className="text-left after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none"
          aria-label={`Open the notes: ${title}`}
        >
          {title}
        </button>
      </h3>

      {body}

      {topics.length > 0 && (
        <ul className="relative z-10 flex flex-wrap gap-1" aria-label="AI tags">
          {topics.slice(0, 3).map((topic) => (
            <li key={topic}>
              <button
                type="button"
                onClick={() => onTopic(topic)}
                className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-ink-secondary hover:text-ink"
              >
                #{topic}
              </button>
            </li>
          ))}
          {extra > 0 && <li className="px-1 py-0.5 text-[11px] text-ink-secondary">+{extra}</li>}
        </ul>
      )}

      <div className="mt-auto flex items-center gap-3 border-t border-line/70 pt-3 text-xs text-ink-secondary">
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={peerName || "?"} size="xs" />
          <span className="truncate">with {peerName || "someone"}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {actions > 0 && (
            <span className="inline-flex items-center gap-1" title={`${actions} action items`}>
              <CheckCircleIcon aria-hidden="true" /> {actions}
            </span>
          )}
          {notes.audio && (
            <span className="inline-flex items-center" title="Recording kept">
              <MicIcon aria-label="Recording kept" />
            </span>
          )}
          {notes.sentToBoard && (
            <span
              className="inline-flex items-center gap-1 text-primary"
              title={`Sent to ${notes.sentToBoard.boardName}`}
            >
              <KanbanIcon aria-hidden="true" /> {notes.sentToBoard.count}
            </span>
          )}
          <ChevronRightIcon
            className="transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </article>
  );
}

/**
 * The full notes of one meeting in a panel from the right (a sheet from the
 * bottom on phones): its title and who, the way back to the conversation,
 * and the notes card itself (summary, action items, Send to Board, the full
 * notes and questions). Esc or the backdrop closes it.
 */
function NoteDrawer({
  message,
  title,
  peerName,
  mine,
  onClose,
}: Readonly<{
  message: Message;
  title: string;
  peerName: string;
  mine: boolean;
  onClose: () => void;
}>) {
  const dialog = useModalDialog(onClose);
  const notes = message.aiNotes!;
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      className="m-0 ml-auto h-full max-h-none w-full max-w-full border-l border-white/10 bg-surface p-0 text-ink backdrop:bg-scrim/50 backdrop:backdrop-blur-sm sm:max-w-2xl"
      data-note-drawer
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
              {notes.category && (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${CATEGORY_TONE[notes.category]}`}
                    aria-hidden="true"
                  />
                  {NOTES_CATEGORY_LABELS[notes.category]}
                </span>
              )}
              <span>
                {formatDay(message.createdAt)} · {formatTime(message.createdAt)} ·{" "}
                {formatCallDuration(notes.endedAt - notes.startedAt)}
              </span>
            </p>
            <h2 className="mt-1 text-lg font-bold leading-snug text-ink">{title}</h2>
            <p className="mt-0.5 text-sm text-ink-secondary">with {peerName || "someone"}</p>
          </div>
          <Link
            to={`/app/${encodeURIComponent(message.channelId)}`}
            className="flex shrink-0 items-center gap-0.5 rounded-md px-2 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
          >
            Open conversation
            <ChevronRightIcon aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            aria-label="Close"
            title="Close (Esc)"
            data-close
          >
            <CloseIcon />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <NoteTopicPicker message={message} />
          {(notes.topics?.length ?? 0) > 0 && (
            <ul className="mb-3 flex flex-wrap gap-1" aria-label="AI tags">
              {notes.topics!.map((topic) => (
                <li
                  key={topic}
                  className="rounded-md bg-surface-sidebar px-1.5 py-0.5 text-xs text-ink-secondary"
                >
                  #{topic}
                </li>
              ))}
            </ul>
          )}
          <AiNotesCard message={message} mine={mine} />
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
