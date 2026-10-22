import {
  extractActionItems,
  MAX_TASKS_FROM_NOTES,
  taskDraftOf,
  type Message,
} from "@mindfultech/shared";
import { useId, useMemo, useState, type FormEvent } from "react";
import { saveLastNotesBoard, loadLastNotesBoard, preferredBoard } from "../lib/notesBoard";
import { tasksApi, TasksApiError } from "../lib/tasksApi";
import { useChat, useNameOf } from "../store";
import { useNotesHub } from "../store/notesHub";
import { useTasks } from "../store/tasks";
import { Avatar } from "./Avatar";
import { Modal, SecondaryButton } from "./Modal";

/**
 * "Send to Board" (Phase 29): the action items of an AI notes card, ready to
 * become tasks. Pick the board (preselected: a project you both work on, or
 * the one used last), untick anything the notes got wrong, and they're
 * created in To Do in one request. Owners named in an item ("**Ana**: …")
 * become the assignee when they are on the chosen board.
 */
export function SendToBoardModal({
  message,
  onClose,
}: Readonly<{ message: Message; onClose: () => void }>) {
  const notes = message.aiNotes!;
  const boards = useTasks((s) => s.boards);
  const channels = useChat((s) => s.channels);
  const users = useChat((s) => s.users);
  const showToast = useChat((s) => s.showToast);
  const nameOf = useNameOf();
  const items = useMemo(() => extractActionItems(notes.summary), [notes.summary]);
  const [boardId, setBoardId] = useState(
    () => preferredBoard(boards, channels, notes.participants, loadLastNotesBoard()) ?? "",
  );
  const board = boards.find((b) => b.boardId === boardId);
  const [checked, setChecked] = useState<boolean[]>(() =>
    items.map((_, i) => i < MAX_TASKS_FROM_NOTES),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  // Owners resolve against the chosen board's people.
  const drafts = useMemo(() => {
    const members = (board ? [board.ownerId, ...board.members] : []).map((userId) => ({
      userId,
      displayName: users[userId]?.displayName,
      email: users[userId]?.email,
    }));
    return items.map((item) => taskDraftOf(item, members));
  }, [items, board, users]);
  const chosen = drafts.filter((_, i) => checked[i]);
  const tooMany = chosen.length > MAX_TASKS_FROM_NOTES;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!board || chosen.length === 0 || tooMany || sending) return;
    setSending(true);
    setError(null);
    try {
      const { notes: updated } = await tasksApi.createFromNotes(board.boardId, {
        channelId: message.channelId,
        sk: message.sk,
        tasks: chosen,
      });
      saveLastNotesBoard(board.boardId);
      // The server tells both people too; this makes the button settle at once.
      useChat.getState().updateAiNotes(message.channelId, message.sk, updated, message.text);
      useNotesHub.getState().update(message.channelId, message.sk, updated, message.text);
      const what = chosen.length === 1 ? "1 task" : `${chosen.length} tasks`;
      showToast(`${what} added to the ${board.name} board`);
      onClose();
    } catch (err) {
      setSending(false);
      setError(err instanceof TasksApiError ? err.message : "Couldn't add the tasks. Try again.");
    }
  }

  return (
    <Modal
      title="Send action items to a board"
      width="md"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form={formId}
            className="btn-primary"
            disabled={!board || chosen.length === 0 || tooMany || sending}
          >
            {sending
              ? "Adding…"
              : `Add ${chosen.length === 1 ? "1 task" : `${chosen.length} tasks`}`}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="space-y-4">
        <div>
          <label htmlFor={`${formId}-board`} className="mb-1 block text-sm font-medium text-ink">
            Board
          </label>
          <select
            id={`${formId}-board`}
            className="input"
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.boardId} value={b.boardId}>
                {b.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-secondary">New tasks go to To Do.</p>
        </div>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">
            Action items ({chosen.length} of {items.length})
          </legend>
          <ul className="max-h-[45vh] space-y-1 overflow-y-auto rounded-lg border border-line p-1">
            {drafts.map((draft, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    checked={checked[i] ?? false}
                    onChange={(e) =>
                      setChecked((list) => list.map((v, j) => (j === i ? e.target.checked : v)))
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm text-ink">{draft.title}</span>
                    {draft.description && (
                      <span className="block break-words text-xs text-ink-secondary">
                        {draft.description}
                      </span>
                    )}
                  </span>
                  {draft.assigneeId && (
                    <span
                      className="flex shrink-0 items-center gap-1 text-xs text-ink-secondary"
                      title={`Assigned to ${nameOf(draft.assigneeId)}`}
                    >
                      <Avatar name={nameOf(draft.assigneeId)} size="xs" />
                      {nameOf(draft.assigneeId)}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          {tooMany && (
            <p className="mt-1 text-xs text-error">
              At most {MAX_TASKS_FROM_NOTES} tasks at a time: untick a few.
            </p>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
