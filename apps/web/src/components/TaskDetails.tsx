import { MAX_TASK_NOTES_LENGTH, MAX_TASK_TITLE_LENGTH, type Board } from "@mindfultech/shared";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useNameOf } from "../store";
import { useTasks } from "../store/tasks";
import { TrashIcon } from "./icons";
import { Modal } from "./Modal";
import { PasteStatus, TaskImages, useImagePaste } from "./TaskImages";
import {
  AttachmentsSection,
  Field,
  ProjectAndAssignee,
  StatusPicker,
  useFileDrop,
  useFileUploads,
} from "./TaskForm";

/**
 * Local text that saves on blur or Enter. While the field is focused the
 * server's value is left alone (someone else may be editing the same task);
 * once blurred, outside updates flow in again.
 */
function useDraft(value: string, save: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // For `apply`, which runs whenever an upload finishes, focused or not.
  const latest = useRef({ draft, focused, value });
  latest.current = { draft, focused, value };
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    const next = draft.trim();
    if (next !== value) save(next);
    else setDraft(value);
  };
  const field = {
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: commit,
    /** Enter commits single-line fields; Escape reverts. */
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !(e.currentTarget instanceof HTMLTextAreaElement)) {
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        setDraft(value);
        e.currentTarget.blur();
      }
    },
  };
  return {
    /** Spread on the input or textarea. */
    field,
    /**
     * Changes the text from outside the keyboard (a pasted image's reference
     * arriving, Phase 33): into the draft while the field is being edited,
     * saved at once otherwise (it was left before the upload finished).
     */
    apply: (change: (text: string) => string) => {
      const { draft: current, focused: editing, value: saved } = latest.current;
      const next = change(editing ? current : saved);
      latest.current = { ...latest.current, draft: next };
      setDraft(next);
      if (!editing && next.trim() !== saved) save(next.trim());
    },
  };
}

/**
 * Everything about one task. Fields save on blur / Enter through the optimistic
 * store, and the modal reads the task back from the store, so other members'
 * edits show up live; it closes itself if the task is deleted elsewhere.
 */
export function TaskDetails({
  taskId,
  board,
  onClose,
}: Readonly<{ taskId: string; board: Board; onClose: () => void }>) {
  const task = useTasks((s) => s.tasksByBoard[board.boardId]?.find((t) => t.taskId === taskId));
  const editTask = useTasks((s) => s.editTask);
  const moveTask = useTasks((s) => s.moveTask);
  const deleteTask = useTasks((s) => s.deleteTask);
  const nameOf = useNameOf();

  // Deleted (here or by someone else): nothing left to show.
  useEffect(() => {
    if (!task) onClose();
  }, [task, onClose]);

  const title = useDraft(task?.title ?? "", (v) => v && void editTask(taskId, { title: v }));
  const project = useDraft(task?.project ?? "", (v) => void editTask(taskId, { project: v }));
  const notes = useDraft(task?.notes ?? "", (v) => void editTask(taskId, { notes: v }));

  const { uploads, addFiles, full } = useFileUploads(
    board.boardId,
    task?.attachments.length ?? 0,
    async (added) => {
      const current =
        useTasks.getState().tasksByBoard[board.boardId]?.find((t) => t.taskId === taskId)
          ?.attachments ?? [];
      await editTask(taskId, { attachments: [...current, ...added] });
    },
  );
  const drop = useFileDrop((files) => void addFiles(files));
  // A pasted image (Phase 33) joins the task's files; the notes refer to it.
  const notesPaste = useImagePaste({
    boardId: board.boardId,
    attached: (task?.attachments.length ?? 0) + uploads.length,
    apply: notes.apply,
    onUploaded: async (file) => {
      const current =
        useTasks.getState().tasksByBoard[board.boardId]?.find((t) => t.taskId === taskId)
          ?.attachments ?? [];
      await editTask(taskId, { attachments: [...current, file] });
    },
  });

  if (!task) return null;

  return (
    <Modal
      title="Task details"
      width="lg"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              void deleteTask(taskId);
              onClose();
            }}
            className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-error hover:bg-error/10"
          >
            <TrashIcon /> Delete task
          </button>
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </>
      }
    >
      <div className="space-y-5" {...drop.handlers}>
        <Field id="task-title" label="Title">
          <input
            id="task-title"
            className="input text-base font-semibold"
            maxLength={MAX_TASK_TITLE_LENGTH}
            {...title.field}
          />
        </Field>

        <StatusPicker value={task.status} onChange={(status) => void moveTask(taskId, status)} />

        <ProjectAndAssignee
          board={board}
          project={project.field}
          assigneeId={task.assigneeId}
          onAssigneeChange={(assigneeId) => void editTask(taskId, { assigneeId })}
        />

        <Field id="task-notes" label="Notes">
          <textarea
            id="task-notes"
            className="input min-h-[14rem] resize-y leading-relaxed"
            placeholder="Context, links, decisions… (paste screenshots too)"
            maxLength={MAX_TASK_NOTES_LENGTH}
            {...notes.field}
            onPaste={notesPaste.onPaste}
          />
          <PasteStatus pending={notesPaste.pending} />
          <TaskImages text={notes.field.value} attachments={task.attachments} />
        </Field>

        <AttachmentsSection
          attachments={task.attachments}
          uploads={uploads}
          full={full}
          dragging={drop.dragging}
          onAdd={(files) => void addFiles(files)}
          onRemove={(key) =>
            void editTask(taskId, { attachments: task.attachments.filter((a) => a.key !== key) })
          }
        />

        <p className="text-xs text-ink-secondary">
          Added by {nameOf(task.createdBy)}. Changes save as you go and show up for everyone on the
          board.
        </p>
      </div>
    </Modal>
  );
}
