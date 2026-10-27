import { extractActionItems, type AiNotes, type Message } from "@mindfultech/shared";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatCallDuration } from "../lib/call";
import { useNow } from "../lib/hooks";
import { renderNotesMarkdown } from "../lib/markdown";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useChat, useNameOf } from "../store";
import { useTasks } from "../store/tasks";
import { Attachment } from "./Attachment";
import { CheckIcon, ChevronDownIcon, CopyIcon, KanbanIcon, SparklesIcon } from "./icons";
import { NoteDetails } from "./NoteDetails";

const SendToBoardModal = lazy(() =>
  import("./SendToBoardModal").then((m) => ({ default: m.SendToBoardModal })),
);

/**
 * A card still pending this long after the call is presumed lost (the worker
 * gives up well before): 5 minutes, plus a tenth of the call for its polished
 * minutes (Phase 40), at most 16 minutes.
 */
export const NOTES_STALE_MS = 5 * 60_000;
export const notesStaleAfter = (callMs: number) =>
  Math.min(16 * 60_000, NOTES_STALE_MS + Math.max(0, callMs) / 10);

/** Every card wants to know your boards; ask the server once per session. */
let boardsRequested = false;
function useMyBoards() {
  const boards = useTasks((s) => s.boards);
  const loaded = useTasks((s) => s.boardsLoaded);
  useEffect(() => {
    if (loaded || boardsRequested || !tasksApiConfigured()) return;
    boardsRequested = true;
    void useTasks
      .getState()
      .loadBoards()
      .finally(() => {
        boardsRequested = false;
      });
  }, [loaded]);
  return boards;
}

/**
 * "Send to Board" under a ready card (Phase 29): shown when you're on a
 * board; disabled when the notes have no action-item section; replaced by
 * where the items went once anyone sent them.
 */
function BoardAction({ message }: Readonly<{ message: Message }>) {
  const notes = message.aiNotes!;
  const boards = useMyBoards();
  const guest = useChat((s) => s.me?.role === "guest");
  const nameOf = useNameOf();
  const [open, setOpen] = useState(false);
  const count = useMemo(() => extractActionItems(notes.summary).length, [notes.summary]);
  const sent = notes.sentToBoard;
  const boardsLoaded = useTasks((s) => s.boardsLoaded);
  if (sent) {
    const onBoard = !boardsLoaded || boards.some((b) => b.boardId === sent.boardId);
    const what = sent.count === 1 ? "1 task" : `${sent.count} tasks`;
    return (
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
        <CheckIcon className="text-success" aria-hidden="true" />
        <span>
          {what} sent to{" "}
          {onBoard ? (
            <Link
              to={`/app/tasks/${encodeURIComponent(sent.boardId)}`}
              className="font-semibold text-ink underline decoration-primary decoration-2 underline-offset-2"
            >
              {sent.boardName}
            </Link>
          ) : (
            // Deleted since (Phase 32), or a board you're not on: nothing to open.
            <span className="font-semibold text-ink">{sent.boardName}</span>
          )}{" "}
          by {nameOf(sent.by)}
        </span>
      </p>
    );
  }
  if (guest || boards.length === 0) return null;
  const label = count === 0 ? "No action items found" : "Send to Board";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={count === 0}
        title={
          count === 0
            ? "These notes have no Action Items (or Tareas) section"
            : `Add ${count === 1 ? "its action item" : `its ${count} action items`} to a board`
        }
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-primary/60 bg-surface px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:border-line disabled:text-ink-secondary disabled:hover:bg-surface"
      >
        <KanbanIcon className="text-primary" aria-hidden="true" />
        {label}
        {count > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 text-xs tabular-nums">{count}</span>
        )}
      </button>
      {open && (
        <Suspense fallback={null}>
          <SendToBoardModal message={message} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

/**
 * An `ai_notes` message (Phase 28): the summary and action items Claude
 * wrote from a call's transcript. Posted as a pending card the moment the
 * call ends; the worker fills it in (`message.updated`) a few seconds later,
 * or marks it failed. The model's markdown goes through
 * `renderNotesMarkdown`, which escapes everything before adding its own tags.
 */
export function AiNotesCard({ message, mine }: Readonly<{ message: Message; mine: boolean }>) {
  const notes: AiNotes = message.aiNotes!;
  const nameOf = useNameOf();
  const showToast = useChat((s) => s.showToast);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const html = useMemo(
    () => (notes.status === "ready" ? renderNotesMarkdown(notes.summary) : ""),
    [notes.status, notes.summary],
  );
  const stale =
    notes.status === "pending" &&
    now - notes.endedAt > notesStaleAfter(notes.endedAt - notes.startedAt);
  const people = notes.participants.map((id) => nameOf(id)).join(" & ");

  async function copy() {
    try {
      await navigator.clipboard.writeText(notes.summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast("Couldn't copy the notes.");
    }
  }

  return (
    <div
      className={`mt-1 w-full max-w-xl overflow-hidden rounded-2xl rounded-tl-sm border border-line ${
        mine ? "bg-primary/10" : "bg-surface-sidebar"
      }`}
      data-ai-notes={notes.callId}
      data-status={notes.status}
    >
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        <SparklesIcon className="text-primary" aria-hidden="true" />
        AI Call Notes
        {notes.status === "ready" && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : "Copy the notes as markdown"}
            title={copied ? "Copied" : "Copy the notes as markdown"}
            className="ml-auto rounded-md p-1 normal-case tracking-normal text-ink-secondary hover:bg-surface-hover hover:text-ink"
          >
            {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          </button>
        )}
      </div>
      <div className="px-3 py-2.5">
        <p className="text-xs text-ink-secondary">
          {people} · {formatCallDuration(notes.endedAt - notes.startedAt)}
        </p>
        {/* Phase 40: the call's recording (both voices, while notes were on). */}
        {notes.audio && (
          <div className="mt-2" data-note-audio>
            <Attachment
              attachment={{
                key: notes.audio.key,
                name: "Call recording",
                size: notes.audio.size,
                contentType: notes.audio.contentType,
                durationMs: notes.audio.durationMs,
              }}
            />
          </div>
        )}
        {notes.status === "pending" && !stale && (
          <div role="status" className="mt-2 space-y-2" aria-label="Generating the notes">
            <p className="text-sm text-ink-secondary">Generating notes…</p>
            <div className="h-3 w-11/12 animate-pulse rounded bg-surface-hover" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface-hover" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-surface-hover" />
          </div>
        )}
        {stale && (
          <p className="mt-2 text-sm text-ink-secondary">
            The notes are taking much longer than usual and may not arrive.
          </p>
        )}
        {notes.status === "failed" && (
          <p className="mt-2 text-sm text-ink-secondary">
            {notes.error ?? "The notes couldn't be generated."}
          </p>
        )}
        {notes.status === "ready" && (
          <>
            <div
              className="md md-notes mt-2 break-words text-sm leading-relaxed text-ink"
              // Safe: renderNotesMarkdown escapes all text before adding its own tags.
              dangerouslySetInnerHTML={{ __html: html }}
            />
            <BoardAction message={message} />
            {notes.details && (
              <>
                <button
                  type="button"
                  onClick={() => setOpen((v) => !v)}
                  aria-expanded={open}
                  className="mt-2 flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                  data-open-notes
                >
                  {open ? "Hide full notes" : "Open full notes"}
                  <ChevronDownIcon
                    className={`transition-transform ${open ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </button>
                {open && <NoteDetails callId={notes.callId} />}
              </>
            )}
            <p className="mt-2 border-t border-line/70 pt-2 text-[11px] text-ink-secondary">
              Written by AI from the call&apos;s transcript: check names, dates and figures.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
