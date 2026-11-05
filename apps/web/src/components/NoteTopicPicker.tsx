import {
  foldMeetingTopic,
  MAX_MEETING_TOPIC_LENGTH,
  MEETING_TOPIC_SUGGESTIONS,
  type Message,
} from "@mindfultech/shared";
import { useMemo, useState, type FormEvent } from "react";
import { notesApi } from "../lib/notesApi";
import { useChat } from "../store";
import { useNotesHub } from "../store/notesHub";
import { CheckIcon, ChevronDownIcon, CloseIcon, FolderIcon } from "./icons";

/**
 * The meeting's topic in its notes panel (Phase 50): a pill that opens a
 * picker in place (the panel is a modal dialog, so nothing floats over it):
 * the usual kinds of meeting, your own topics so far, a field for a new one,
 * and Remove. The choice is saved for everyone in the call.
 */
export function NoteTopicPicker({ message }: Readonly<{ message: Message }>) {
  const notes = message.aiNotes!;
  const current = notes.topic ?? null;
  const mine = useNotesHub((s) => s.topics);
  const showToast = useChat((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // The suggestions, then yours, each once however it's written.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const topic of [...MEETING_TOPIC_SUGGESTIONS, ...mine.map((t) => t.topic)]) {
      const key = foldMeetingTopic(topic);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(topic);
    }
    return list;
  }, [mine]);

  async function choose(topic: string | null) {
    setBusy(true);
    try {
      const aiNotes = await notesApi.setTopic(notes.callId, {
        channelId: message.channelId,
        sk: message.sk,
        topic,
      });
      useNotesHub.getState().update(message.channelId, message.sk, aiNotes, message.text);
      setOpen(false);
      setDraft("");
      showToast(topic ? `Filed under ${aiNotes.topic ?? topic}` : "Topic removed", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't change the topic.", "error");
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const topic = draft.trim();
    if (topic) void choose(topic);
  }

  const isCurrent = (topic: string) =>
    current !== null && foldMeetingTopic(topic) === foldMeetingTopic(current);

  return (
    <div className="mb-4" data-topic-picker>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
          current
            ? "border-primary/50 bg-primary/15 text-ink hover:bg-primary/25"
            : "border-dashed border-line text-ink-secondary hover:border-primary/50 hover:text-ink"
        }`}
        data-topic-current={current ?? ""}
      >
        <FolderIcon aria-hidden="true" />
        {current ?? "Add a topic"}
        <ChevronDownIcon className={open ? "rotate-180" : ""} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="mt-2 rounded-xl border border-white/10 bg-surface-sidebar p-3 shadow-lg"
          role="group"
          aria-label="Meeting topic"
        >
          <p className="mb-2 text-xs text-ink-secondary">
            File this meeting under a topic, for everyone in it.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {options.map((topic) => (
              <button
                key={topic}
                type="button"
                disabled={busy}
                onClick={() => void (isCurrent(topic) ? setOpen(false) : choose(topic))}
                aria-pressed={isCurrent(topic)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
                  isCurrent(topic)
                    ? "border-primary bg-primary/20 text-ink"
                    : "border-line text-ink-secondary hover:border-primary/50 hover:text-ink"
                }`}
              >
                {isCurrent(topic) && <CheckIcon aria-hidden="true" />}
                {topic}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="mt-3 flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_MEETING_TOPIC_LENGTH}
              placeholder="New topic…"
              aria-label="New topic"
              className="input min-w-0 flex-1 py-1.5 text-sm"
              disabled={busy}
            />
            <button
              type="submit"
              className="btn-primary px-3 py-1.5 text-xs"
              disabled={busy || !draft.trim()}
            >
              Add
            </button>
          </form>
          {current && (
            <button
              type="button"
              onClick={() => void choose(null)}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-secondary hover:bg-error/10 hover:text-error disabled:opacity-60"
            >
              <CloseIcon aria-hidden="true" /> Remove topic
            </button>
          )}
        </div>
      )}
    </div>
  );
}
