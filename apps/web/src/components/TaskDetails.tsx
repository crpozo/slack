import {
  MAX_TASK_ATTACHMENTS,
  MAX_TASK_NOTES_LENGTH,
  MAX_TASK_PROJECT_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  type Attachment,
  type Board,
  type TaskStatus,
} from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { formatBytes, getDownloadUrl, uploadFile } from "../lib/upload";
import { useChat, useNameOf } from "../store";
import { useTasks } from "../store/tasks";
import { DownloadIcon, FileIcon, PaperclipIcon, TrashIcon } from "./icons";
import { Modal } from "./Modal";

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  DONE: "Done",
};

/**
 * Local text that saves on blur or Enter. While the field is focused the
 * server's value is left alone (someone else may be editing the same task);
 * once blurred, outside updates flow in again.
 */
function useDraft(value: string, save: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    const next = draft.trim();
    if (next !== value) save(next);
    else setDraft(value);
  };
  return {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: commit,
    /** Enter commits single-line fields; Escape reverts. */
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !(e.currentTarget instanceof HTMLTextAreaElement)) {
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        setDraft(value);
        e.currentTarget.blur();
      }
    },
  };
}

function AttachmentRow({
  attachment,
  onRemove,
}: Readonly<{ attachment: Attachment; onRemove: () => void }>) {
  const showToast = useChat((s) => s.showToast);
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    try {
      const url = await getDownloadUrl(attachment.key);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't download the file.");
    } finally {
      setOpening(false);
    }
  }
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
      <FileIcon className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{attachment.name}</span>
        <span className="block text-xs text-ink-secondary">{formatBytes(attachment.size)}</span>
      </span>
      <button
        type="button"
        onClick={() => void open()}
        disabled={opening}
        aria-label={`Download ${attachment.name}`}
        title="Download"
        className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
      >
        <DownloadIcon />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        title="Remove"
        className="rounded-md p-1.5 text-ink-secondary hover:bg-error/15 hover:text-error"
      >
        <TrashIcon />
      </button>
    </li>
  );
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
  // Selected as the stable list, derived with useMemo: a selector returning a fresh
  // array each call would re-render forever.
  const boardTasks = useTasks((s) => s.tasksByBoard[board.boardId]);
  const projects = useMemo(
    () =>
      [...new Set((boardTasks ?? []).map((t) => t.project).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [boardTasks],
  );
  const showToast = useChat((s) => s.showToast);
  const nameOf = useNameOf();
  const myUserId = useChat((s) => s.me?.userId);
  const [uploads, setUploads] = useState<Array<{ name: string; progress: number }>>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Deleted (here or by someone else): nothing left to show.
  useEffect(() => {
    if (!task) onClose();
  }, [task, onClose]);

  const title = useDraft(task?.title ?? "", (v) => v && void editTask(taskId, { title: v }));
  const project = useDraft(task?.project ?? "", (v) => void editTask(taskId, { project: v }));
  const notes = useDraft(task?.notes ?? "", (v) => void editTask(taskId, { notes: v }));

  if (!task) return null;

  async function addFiles(files: FileList | File[]) {
    const list = [...files];
    const room = MAX_TASK_ATTACHMENTS - task!.attachments.length - uploads.length;
    if (list.length > room) {
      showToast(`A task can have at most ${MAX_TASK_ATTACHMENTS} attachments.`);
      list.splice(Math.max(room, 0));
    }
    if (list.length === 0) return;
    setUploads((u) => [...u, ...list.map((f) => ({ name: f.name, progress: 0 }))]);
    const setProgress = (name: string, progress: number) =>
      setUploads((u) => u.map((x) => (x.name === name ? { ...x, progress } : x)));
    // Uploads run in parallel; one PUT then attaches everything that made it.
    const results = await Promise.allSettled(
      list.map((file) => uploadFile(file, board.boardId, (p) => setProgress(file.name, p))),
    );
    setUploads((u) => u.filter((x) => !list.some((f) => f.name === x.name)));
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const err: unknown = r.reason;
        showToast(err instanceof Error ? err.message : `Couldn't upload ${list[i]?.name}.`);
      }
    });
    if (added.length === 0) return;
    const current =
      useTasks.getState().tasksByBoard[board.boardId]?.find((t) => t.taskId === taskId)
        ?.attachments ?? [];
    await editTask(taskId, { attachments: [...current, ...added] });
  }

  function removeAttachment(key: string) {
    void editTask(taskId, { attachments: task!.attachments.filter((a) => a.key !== key) });
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  }

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
      <div
        className="space-y-5"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <div className="space-y-1.5">
          <label htmlFor="task-title" className="text-xs font-medium text-ink-secondary">
            Title
          </label>
          <input
            id="task-title"
            className="input text-base font-semibold"
            maxLength={MAX_TASK_TITLE_LENGTH}
            {...title}
          />
        </div>

        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Status">
          {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => (
            <button
              key={status}
              type="button"
              role="radio"
              aria-checked={task.status === status}
              onClick={() => void moveTask(taskId, status)}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                task.status === status
                  ? "border-primary bg-primary/15 font-semibold text-ink"
                  : "border-line text-ink-secondary hover:bg-surface-hover hover:text-ink"
              }`}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="task-project" className="text-xs font-medium text-ink-secondary">
              Project
            </label>
            <input
              id="task-project"
              className="input"
              list="task-projects"
              placeholder="e.g. Website"
              maxLength={MAX_TASK_PROJECT_LENGTH}
              {...project}
            />
            <datalist id="task-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="task-assignee" className="text-xs font-medium text-ink-secondary">
              Assignee
            </label>
            <select
              id="task-assignee"
              className="input"
              value={task.assigneeId ?? ""}
              onChange={(e) => void editTask(taskId, { assigneeId: e.target.value || null })}
            >
              <option value="">Unassigned</option>
              {board.members.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                  {id === myUserId ? " (you)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="task-notes" className="text-xs font-medium text-ink-secondary">
            Notes
          </label>
          <textarea
            id="task-notes"
            className="input min-h-[14rem] resize-y leading-relaxed"
            placeholder="Context, links, decisions…"
            maxLength={MAX_TASK_NOTES_LENGTH}
            {...notes}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-secondary">
              Attachments ({task.attachments.length})
            </span>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={task.attachments.length + uploads.length >= MAX_TASK_ATTACHMENTS}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
            >
              <PaperclipIcon /> Add file
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              aria-label="Attach files"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <ul className="space-y-1.5">
            {task.attachments.map((a) => (
              <AttachmentRow key={a.key} attachment={a} onRemove={() => removeAttachment(a.key)} />
            ))}
            {uploads.map((u) => (
              <li
                key={u.name}
                className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink-secondary"
                aria-label={`Uploading ${u.name}`}
              >
                <FileIcon className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="text-xs">{Math.round(u.progress * 100)}%</span>
              </li>
            ))}
          </ul>
          <div
            className={`rounded-xl border border-dashed px-3 py-4 text-center text-xs transition-colors ${
              dragging ? "border-primary bg-primary/10 text-ink" : "border-line text-ink-secondary"
            }`}
          >
            Drop files here to attach them (up to {MAX_TASK_ATTACHMENTS}, 25 MB each)
          </div>
        </div>

        <p className="text-xs text-ink-secondary">
          Added by {nameOf(task.createdBy)}. Changes save as you go and show up for everyone on the
          board.
        </p>
      </div>
    </Modal>
  );
}
