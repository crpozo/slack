import {
  MAX_NOTE_QUESTION_CHARS,
  MAX_QUESTIONS_PER_NOTE,
  type NoteDetail,
  type NoteQuestion,
} from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { renderNotesMarkdown } from "../lib/markdown";
import { notesApi } from "../lib/notesApi";
import { TasksApiError } from "../lib/tasksApi";
import { SendIcon, SparklesIcon } from "./icons";

// ---------------------------------------------------------------------------
// Phase 40: a call's full notes, opened from its ✨ card. The polished minutes
// are the main content; the transcript as Whisper heard it (Phase 43; the
// browsers before) is one click away; and you can ask questions about the call, answered from the minutes.
// Your questions are yours alone: nobody else in the call sees them.
// ---------------------------------------------------------------------------

/** Opened once per session per call: reopening the card shows them at once. */
const loaded = new Map<string, NoteDetail>();

const errorText = (err: unknown, fallback: string) =>
  err instanceof TasksApiError ? err.message : fallback;

function Markdown({ text, className = "" }: Readonly<{ text: string; className?: string }>) {
  const html = useMemo(() => renderNotesMarkdown(text), [text]);
  return (
    <div
      className={`md md-notes break-words text-sm leading-relaxed text-ink ${className}`}
      // Safe: renderNotesMarkdown escapes all text before adding its own tags.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Your questions and their answers, and the box to ask another. */
function Questions({
  callId,
  questions,
  onAsked,
}: Readonly<{ callId: string; questions: NoteQuestion[]; onAsked: (q: NoteQuestion) => void }>) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const left = MAX_QUESTIONS_PER_NOTE - questions.length;

  useEffect(() => {
    if (asking || questions.length > 0) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [asking, questions.length]);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (!text || asking || left <= 0) return;
    setAsking(text);
    setError(null);
    setQuestion("");
    try {
      onAsked(await notesApi.ask(callId, text));
    } catch (err) {
      setQuestion(text); // to try again
      setError(errorText(err, "The question couldn't be answered. Try again."));
    } finally {
      setAsking(null);
    }
  }

  return (
    <section className="mt-3 border-t border-line/70 pt-3" aria-label="Questions about this call">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        <SparklesIcon className="text-primary" aria-hidden="true" />
        Ask about this call
        <span className="ml-auto font-normal normal-case tracking-normal">Only you see these</span>
      </h4>
      {(questions.length > 0 || asking) && (
        <ol className="mt-2 space-y-3" data-note-questions>
          {questions.map((q) => (
            <li key={q.askedAt} className="space-y-1.5">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary/15 px-3 py-1.5 text-sm text-ink">
                {q.question}
              </p>
              <Markdown
                text={q.answer}
                className="max-w-[92%] rounded-2xl rounded-bl-sm bg-surface px-3 py-1.5"
              />
            </li>
          ))}
          {asking && (
            <li className="space-y-1.5">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary/15 px-3 py-1.5 text-sm text-ink">
                {asking}
              </p>
              <p role="status" className="flex items-center gap-2 px-3 text-sm text-ink-secondary">
                <span
                  className="h-3 w-3 animate-spin rounded-full border-2 border-ink-secondary/40 border-t-ink-secondary motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Reading the notes…
              </p>
            </li>
          )}
        </ol>
      )}
      <div ref={endRef} />
      {error && (
        <p className="mt-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}
      {left > 0 ? (
        <form onSubmit={(e) => void ask(e)} className="mt-2 flex items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_NOTE_QUESTION_CHARS}
            placeholder="Ask a question about this note…"
            aria-label="Ask a question about this note"
            disabled={!!asking}
            className="min-w-0 flex-1 rounded-full border border-line bg-surface px-3.5 py-2 text-sm text-ink placeholder:text-ink-secondary focus:border-primary focus:outline-none disabled:opacity-60"
            data-note-ask
          />
          <button
            type="submit"
            disabled={!question.trim() || !!asking}
            aria-label="Ask"
            title="Ask"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-40"
          >
            <SendIcon />
          </button>
        </form>
      ) : (
        <p className="mt-2 text-xs text-ink-secondary">
          You&apos;ve asked the {MAX_QUESTIONS_PER_NOTE} questions a call&apos;s notes allow.
        </p>
      )}
    </section>
  );
}

/** The full notes of `callId`: the minutes, the original transcript, your questions. */
export function NoteDetails({ callId }: Readonly<{ callId: string }>) {
  const [detail, setDetail] = useState<NoteDetail | null>(() => loaded.get(callId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);

  useEffect(() => {
    if (loaded.has(callId)) return;
    let cancelled = false;
    notesApi.detail(callId).then(
      (d) => {
        if (d.polishedText !== null) loaded.set(callId, d);
        if (!cancelled) setDetail(d);
      },
      (err: unknown) => !cancelled && setError(errorText(err, "Couldn't load the notes.")),
    );
    return () => {
      cancelled = true;
    };
  }, [callId]);

  if (error) {
    return (
      <p className="mt-3 text-sm text-ink-secondary" role="alert">
        {error}
      </p>
    );
  }
  if (!detail) {
    return (
      <div role="status" aria-label="Loading the notes" className="mt-3 space-y-2">
        <div className="h-3 w-11/12 animate-pulse rounded bg-surface-hover" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-surface-hover" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-surface-hover" />
      </div>
    );
  }

  const asked = (q: NoteQuestion) => {
    const next = { ...detail, questions: [...detail.questions, q] };
    loaded.set(callId, next);
    setDetail(next);
  };

  return (
    <div className="mt-3 border-t border-line/70 pt-3" data-note-details>
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
          {original ? "Original transcript" : "Minutes"}
        </h4>
        <button
          type="button"
          onClick={() => setOriginal((v) => !v)}
          aria-pressed={original}
          className="ml-auto rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
          data-toggle-transcript
        >
          {original ? "View polished minutes" : "View original transcript"}
        </button>
      </div>
      {original ? (
        <pre
          className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-2 font-sans text-sm leading-relaxed text-ink-secondary"
          data-raw-transcript
        >
          {detail.rawTranscript}
        </pre>
      ) : detail.polishedText ? (
        <div className="mt-2 max-h-[32rem] overflow-y-auto pr-1" data-polished>
          <Markdown text={detail.polishedText} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-secondary">
          The polished minutes aren&apos;t available for this call. The original transcript is.
        </p>
      )}
      {detail.polishedText && (
        <Questions callId={callId} questions={detail.questions} onAsked={asked} />
      )}
    </div>
  );
}
