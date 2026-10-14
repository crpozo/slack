import {
  MAX_TASK_ATTACHMENTS,
  MAX_TASK_PROJECT_LENGTH,
  type Attachment,
  type Board,
  type TaskStatus,
} from "@mindfultech/shared";
import {
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { formatBytes, getDownloadUrl, MAX_SIZE_LABEL, uploadFile } from "../lib/upload";
import { useChat, useNameOf } from "../store";
import { useTasks } from "../store/tasks";
import { DownloadIcon, FileIcon, PaperclipIcon, TrashIcon } from "./icons";

/**
 * The pieces of a task form, shared by the Task details modal (edits save as
 * you go) and the New task modal (everything is saved at once on Create).
 */

export const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  DONE: "Done",
};

export function StatusPicker({
  value,
  onChange,
}: Readonly<{ value: TaskStatus; onChange: (status: TaskStatus) => void }>) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Status">
      {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => (
        <button
          key={status}
          type="button"
          role="radio"
          aria-checked={value === status}
          onClick={() => onChange(status)}
          className={`rounded-full border px-3 py-1 text-sm transition-colors ${
            value === status
              ? "border-primary bg-primary/15 font-semibold text-ink"
              : "border-line text-ink-secondary hover:bg-surface-hover hover:text-ink"
          }`}
        >
          {STATUS_LABEL[status]}
        </button>
      ))}
    </div>
  );
}

/** Project names already used on the board, for the datalist. */
export function useProjectSuggestions(boardId: string): string[] {
  // Selected as the stable list, derived with useMemo: a selector returning a fresh
  // array each call would re-render forever.
  const boardTasks = useTasks((s) => s.tasksByBoard[boardId]);
  return useMemo(
    () =>
      [...new Set((boardTasks ?? []).map((t) => t.project).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [boardTasks],
  );
}

export function Field({
  id,
  label,
  children,
}: Readonly<{ id: string; label: string; children: ReactNode }>) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Project (free text with suggestions) and Assignee (a board member), side by side. */
export function ProjectAndAssignee({
  board,
  project,
  assigneeId,
  onAssigneeChange,
}: Readonly<{
  board: Board;
  /** Props of the project `<input>` (value/onChange… from the caller's state). */
  project: InputHTMLAttributes<HTMLInputElement>;
  assigneeId: string | null;
  onAssigneeChange: (assigneeId: string | null) => void;
}>) {
  const projects = useProjectSuggestions(board.boardId);
  const nameOf = useNameOf();
  const myUserId = useChat((s) => s.me?.userId);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="task-project" label="Project">
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
      </Field>
      <Field id="task-assignee" label="Assignee">
        <select
          id="task-assignee"
          className="input"
          value={assigneeId ?? ""}
          onChange={(e) => onAssigneeChange(e.target.value || null)}
        >
          <option value="">Unassigned</option>
          {board.members.map((id) => (
            <option key={id} value={id}>
              {nameOf(id)}
              {id === myUserId ? " (you)" : ""}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

// --- Attachments ------------------------------------------------------------------

interface Upload {
  name: string;
  progress: number;
}

/**
 * Uploads files to the board's folder (in parallel) and reports the ones that
 * made it through `onUploaded`; `attached` is how many the task already has.
 */
export function useFileUploads(
  boardId: string,
  attached: number,
  onUploaded: (added: Attachment[]) => void | Promise<void>,
) {
  const showToast = useChat((s) => s.showToast);
  const [uploads, setUploads] = useState<Upload[]>([]);

  async function addFiles(files: FileList | File[]) {
    const list = [...files];
    const room = MAX_TASK_ATTACHMENTS - attached - uploads.length;
    if (list.length > room) {
      showToast(`A task can have at most ${MAX_TASK_ATTACHMENTS} attachments.`);
      list.splice(Math.max(room, 0));
    }
    if (list.length === 0) return;
    setUploads((u) => [...u, ...list.map((f) => ({ name: f.name, progress: 0 }))]);
    const setProgress = (name: string, progress: number) =>
      setUploads((u) => u.map((x) => (x.name === name ? { ...x, progress } : x)));
    const results = await Promise.allSettled(
      list.map((file) => uploadFile(file, boardId, (p) => setProgress(file.name, p))),
    );
    setUploads((u) => u.filter((x) => !list.some((f) => f.name === x.name)));
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const err: unknown = r.reason;
        showToast(err instanceof Error ? err.message : `Couldn't upload ${list[i]?.name}.`);
      }
    });
    if (added.length > 0) await Promise.resolve(onUploaded(added));
  }

  return { uploads, addFiles, full: attached + uploads.length >= MAX_TASK_ATTACHMENTS };
}

/** Drag-and-drop of files onto a form: spread `handlers` on the container. */
export function useFileDrop(onFiles: (files: FileList) => void) {
  const [dragging, setDragging] = useState(false);
  const handlers = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    },
  };
  return { dragging, handlers };
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

/** The attachment list, the "Add file" button, upload progress rows and the drop hint. */
export function AttachmentsSection({
  attachments,
  uploads,
  full,
  dragging,
  onAdd,
  onRemove,
}: Readonly<{
  attachments: Attachment[];
  uploads: Upload[];
  full: boolean;
  dragging: boolean;
  onAdd: (files: FileList) => void;
  onRemove: (key: string) => void;
}>) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-secondary">
          Attachments ({attachments.length})
        </span>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={full}
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
            if (e.target.files) onAdd(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <ul className="space-y-1.5">
        {attachments.map((a) => (
          <AttachmentRow key={a.key} attachment={a} onRemove={() => onRemove(a.key)} />
        ))}
        {uploads.map((u) => (
          <li
            key={u.name}
            className="relative flex items-center gap-2 overflow-hidden rounded-lg border border-line px-3 py-2 text-sm text-ink-secondary"
            aria-label={`Uploading ${u.name}`}
          >
            <FileIcon className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{u.name}</span>
            <span className="text-xs" aria-live="polite">
              Uploading… {Math.round(u.progress * 100)}%
            </span>
            <span
              role="progressbar"
              aria-valuenow={Math.round(u.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="absolute bottom-0 left-0 h-1 bg-primary transition-all"
              style={{ width: `${Math.round(u.progress * 100)}%` }}
            />
          </li>
        ))}
      </ul>
      <div
        className={`rounded-xl border border-dashed px-3 py-4 text-center text-xs transition-colors ${
          dragging ? "border-primary bg-primary/10 text-ink" : "border-line text-ink-secondary"
        }`}
      >
        Drop files here to attach them (up to {MAX_TASK_ATTACHMENTS}, {MAX_SIZE_LABEL} each)
      </div>
    </div>
  );
}
