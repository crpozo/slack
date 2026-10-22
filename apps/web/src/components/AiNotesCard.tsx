import type { AiNotes } from "@mindfultech/shared";
import { useMemo, useState } from "react";
import { formatCallDuration } from "../lib/call";
import { useNow } from "../lib/hooks";
import { renderNotesMarkdown } from "../lib/markdown";
import { useChat, useNameOf } from "../store";
import { CheckIcon, CopyIcon, SparklesIcon } from "./icons";

/** A card still pending this long after the call is presumed lost (the worker gives up well before). */
export const NOTES_STALE_MS = 5 * 60_000;

/**
 * An `ai_notes` message (Phase 28): the summary and action items Claude
 * wrote from a call's transcript. Posted as a pending card the moment the
 * call ends; the worker fills it in (`message.updated`) a few seconds later,
 * or marks it failed. The model's markdown goes through
 * `renderNotesMarkdown`, which escapes everything before adding its own tags.
 */
export function AiNotesCard({ notes, mine }: Readonly<{ notes: AiNotes; mine: boolean }>) {
  const nameOf = useNameOf();
  const showToast = useChat((s) => s.showToast);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const html = useMemo(
    () => (notes.status === "ready" ? renderNotesMarkdown(notes.summary) : ""),
    [notes.status, notes.summary],
  );
  const stale = notes.status === "pending" && now - notes.endedAt > NOTES_STALE_MS;
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
            <p className="mt-2 border-t border-line/70 pt-2 text-[11px] text-ink-secondary">
              Written by AI from the call&apos;s transcript: check names, dates and figures.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
