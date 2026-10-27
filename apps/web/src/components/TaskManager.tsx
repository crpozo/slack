import {
  canAccessBoard,
  canDeleteBoard,
  isTaskArchived,
  MAX_BOARD_NAME_LENGTH,
  type Board,
  type Task,
  type TaskStatus,
} from "@mindfultech/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { tasksApiConfigured } from "../lib/tasksApi";
import { textWithoutImages } from "../lib/taskText";
import { useChat, useNameOf } from "../store";
import { splitBoards, useTasks } from "../store/tasks";
import { Avatar } from "./Avatar";
import {
  ChevronDownIcon,
  KanbanIcon,
  MenuIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
  UserPlusIcon,
} from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { Popover } from "./Popover";
import { NewTaskModal } from "./NewTaskModal";
import { UnreadAlertsDot } from "./NotificationBell";
import { TaskDetails } from "./TaskDetails";
import { TaskImages } from "./TaskImages";
import { UserPicker } from "./UserPicker";

const COLUMNS: Array<{ status: TaskStatus; title: string; accent: string }> = [
  { status: "TODO", title: "To Do", accent: "bg-sky" },
  { status: "IN_PROGRESS", title: "In Progress", accent: "bg-warning" },
  { status: "DONE", title: "Done", accent: "bg-success" },
];
const DRAG_TYPE = "application/x-slack-task";
const acceptsTask = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);

const boardPath = (boardId: string) => `/app/tasks/${encodeURIComponent(boardId)}`;

// --- Modals -----------------------------------------------------------------------

function CreateBoardModal({
  onClose,
  onCreated,
}: Readonly<{ onClose: () => void; onCreated: (board: Board) => void }>) {
  const createBoard = useTasks((s) => s.createBoard);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createBoard(trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the board.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New board"
      width="sm"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="create-board"
            className="btn-primary"
            disabled={busy || !trimmed}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <form id="create-board" onSubmit={handleSubmit} className="space-y-1.5">
        <label htmlFor="board-name" className="text-sm font-medium text-ink">
          Name
        </label>
        <input
          id="board-name"
          className="input"
          placeholder="e.g. Website launch"
          value={name}
          maxLength={MAX_BOARD_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/**
 * The owner shares the board: with team members from the directory, or with
 * anyone by email. A new address becomes a guest account (Cognito emails them
 * a temporary password) that sees only the boards it's invited to.
 */
function ShareBoardModal({ board, onClose }: Readonly<{ board: Board; onClose: () => void }>) {
  const addMembers = useTasks((s) => s.addMembers);
  const invite = useTasks((s) => s.invite);
  const showToast = useChat((s) => s.showToast);
  const myUserId = useChat((s) => s.me?.userId);
  const users = useChat(useShallow((s) => Object.values(s.users)));
  const others = useMemo(
    () =>
      users
        .filter((u) => u.userId !== myUserId)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users, myUserId],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shareLabel = selected.length > 0 ? `Share (${selected.length})` : "Share";
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function share() {
    setBusy(true);
    setError(null);
    try {
      await addMembers(board.boardId, selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't share the board.");
      setBusy(false);
    }
  }

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    if (!emailValid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invite(board.boardId, email.trim());
      chat.refreshUsers(); // their name in the board right away
      showToast(
        result.created
          ? `Invitation sent to ${email.trim()}. They'll get an email with a temporary password.`
          : `${email.trim()} now has access to "${board.name}".`,
        "success",
      );
      setEmail("");
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the invitation.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Share "${board.name}"`}
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || selected.length === 0}
            onClick={() => void share()}
          >
            {busy && selected.length > 0 ? "Sharing…" : shareLabel}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <form onSubmit={(e) => void sendInvite(e)} className="space-y-1.5">
          <label htmlFor="invite-email" className="text-sm font-medium text-ink">
            Invite by email
          </label>
          <div className="flex gap-2">
            <input
              id="invite-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder="client@company.com"
              className="input flex-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={busy || !emailValid}>
              {busy && selected.length === 0 ? "Inviting…" : "Invite"}
            </button>
          </div>
          <p className="text-xs text-ink-secondary">
            People outside the team join as <strong>guests</strong>: they see only the boards
            they're invited to, never your channels or messages.
          </p>
        </form>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-ink">Or add teammates</p>
          <UserPicker
            users={others}
            selected={selected}
            onChange={setSelected}
            locked={board.members}
          />
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// --- Board --------------------------------------------------------------------------

/** Opens the New task modal (the full form: assignee, project, notes, attachments). */
function AddTaskButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-ink-secondary hover:border-primary hover:bg-surface-hover hover:text-ink"
    >
      <PlusIcon /> Add task
    </button>
  );
}

/** "Move to…" for keyboard and touch users, where HTML5 drag and drop doesn't work. */
function MoveMenu({ task }: Readonly<{ task: Task }>) {
  const moveTask = useTasks((s) => s.moveTask);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label={`Move "${task.title}"`}
        title="Move to…"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
      >
        <ChevronDownIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div
            role="menu"
            aria-label="Move to"
            className="w-44 rounded-xl glass-strong border border-white/10 p-1"
          >
            {COLUMNS.filter((c) => c.status !== task.status).map((c) => (
              <button
                key={c.status}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  void moveTask(task.taskId, c.status);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-hover"
              >
                <span className={`h-2 w-2 rounded-full ${c.accent}`} />
                {c.title}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Stable colour per project name, so the same tag always looks the same. */
const TAG_COLORS = [
  "bg-sky/30 text-ink",
  "bg-primary/30 text-ink",
  "bg-warning/40 text-ink",
  "bg-error/25 text-ink",
  "bg-success/35 text-ink",
];
function tagColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length] ?? TAG_COLORS[0]!;
}

function TaskCard({
  task,
  onDragStart,
  onOpen,
}: Readonly<{ task: Task; onDragStart: (id: string) => void; onOpen: (id: string) => void }>) {
  const deleteTask = useTasks((s) => s.deleteTask);
  const nameOf = useNameOf();
  const pending = task.taskId.startsWith("pending_");
  const [dragging, setDragging] = useState(false);
  // Pasted images show as thumbnails, not as their `![…](attachment:…)` text (Phase 33).
  const summary = textWithoutImages(task.description);

  return (
    <article
      draggable={!pending}
      aria-label={task.title}
      data-task-id={task.taskId}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.taskId);
        e.dataTransfer.setData("text/plain", task.title);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
        onDragStart(task.taskId);
      }}
      onDragEnd={() => setDragging(false)}
      className={`group rounded-xl border border-line bg-surface p-3 shadow-sm transition-shadow hover:shadow-md ${
        pending ? "opacity-60" : "cursor-grab active:cursor-grabbing"
      } ${dragging ? "opacity-40" : ""}`}
    >
      {task.project && (
        <span
          className={`mb-1.5 inline-block max-w-full truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tagColor(task.project)}`}
        >
          {task.project}
        </span>
      )}
      <h4 className="text-sm font-medium text-ink">
        <button
          type="button"
          disabled={pending}
          onClick={() => onOpen(task.taskId)}
          className="w-full text-left hover:underline disabled:no-underline"
          aria-label={`Open "${task.title}"`}
        >
          {task.title}
        </button>
      </h4>
      {summary && (
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs text-ink-secondary">
          {summary}
        </p>
      )}
      <TaskImages text={task.description} attachments={task.attachments} compact max={3} />
      <div className="mt-2 flex items-center gap-1">
        {task.attachments.length > 0 && (
          <span
            className="flex items-center gap-0.5 text-xs text-ink-secondary"
            title={`${task.attachments.length} attachment${task.attachments.length === 1 ? "" : "s"}`}
            aria-label={`${task.attachments.length} attachments`}
          >
            <PaperclipIcon /> {task.attachments.length}
          </span>
        )}
        <span className="flex-1" />
        {task.assigneeId && (
          <span
            title={`Assigned to ${nameOf(task.assigneeId)}`}
            aria-label={`Assigned to ${nameOf(task.assigneeId)}`}
          >
            <Avatar name={nameOf(task.assigneeId)} size="xs" />
          </span>
        )}
        {!pending && <MoveMenu task={task} />}
        {!pending && (
          <button
            type="button"
            aria-label={`Delete "${task.title}"`}
            title="Delete"
            onClick={() => void deleteTask(task.taskId)}
            className="rounded-md p-1 text-ink-secondary hover:bg-error/15 hover:text-error"
          >
            <TrashIcon />
          </button>
        )}
      </div>
    </article>
  );
}

function Column({
  column,
  tasks,
  archived = [],
  showArchived = false,
  onToggleArchived,
  draggingId,
  onDragStart,
  onOpen,
  onAdd,
  compact = false,
}: Readonly<{
  column: (typeof COLUMNS)[number];
  tasks: Task[];
  /** Done column: tasks done for over a week, hidden unless `showArchived`. */
  archived?: Task[];
  showArchived?: boolean;
  onToggleArchived?: () => void;
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  /** In a narrow pane: fixed-width columns in a scrolling strip, whatever the viewport. */
  compact?: boolean;
}>) {
  const moveTask = useTasks((s) => s.moveTask);
  const [over, setOver] = useState(false);

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const taskId = e.dataTransfer.getData(DRAG_TYPE) || draggingId;
    if (taskId) void moveTask(taskId, column.status);
  }

  return (
    <section
      aria-label={column.title}
      data-status={column.status}
      onDragOver={(e) => {
        if (!acceptsTask(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={handleDrop}
      className={`flex h-full min-h-[12rem] shrink-0 flex-col rounded-2xl border bg-surface-sidebar p-3 transition-colors ${
        compact
          ? "w-64 snap-start"
          : "w-[calc(100vw-3rem)] max-w-[22rem] snap-center md:w-auto md:min-w-0 md:max-w-none"
      } ${over ? "border-primary bg-primary/10" : "border-line"}`}
    >
      <header className="mb-3 flex items-center gap-2 px-1">
        <span className={`h-2.5 w-2.5 rounded-full ${column.accent}`} aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">{column.title}</h3>
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-secondary">
          {tasks.length}
        </span>
        {onToggleArchived && archived.length > 0 && (
          <button
            type="button"
            onClick={onToggleArchived}
            aria-pressed={showArchived}
            title="Tasks done for over a week are archived"
            className="ml-auto rounded-md px-2 py-0.5 text-xs font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
          >
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </button>
        )}
      </header>
      <div className="flex flex-1 flex-col gap-2">
        {column.status === "TODO" && <AddTaskButton onClick={onAdd} />}
        {tasks.map((task) => (
          <TaskCard key={task.taskId} task={task} onDragStart={onDragStart} onOpen={onOpen} />
        ))}
        {tasks.length === 0 && column.status !== "TODO" && (
          <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-ink-secondary">
            Drop tasks here
          </p>
        )}
        {showArchived && archived.length > 0 && (
          <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3" aria-label="Archived">
            <p className="px-1 text-xs font-medium uppercase tracking-wide text-ink-secondary">
              Archived
            </p>
            {archived.map((task) => (
              <div key={task.taskId} className="opacity-70">
                <TaskCard task={task} onDragStart={onDragStart} onOpen={onOpen} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The board's name; the owner renames it in place (click it, or "Rename" in the
 * board menu). Enter/blur save, Escape cancels.
 */
function BoardTitle({
  board,
  editable,
  editing,
  setEditing,
}: Readonly<{
  board: Board;
  editable: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}>) {
  const renameBoard = useTasks((s) => s.renameBoard);
  const [draft, setDraft] = useState(board.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(board.name);
    input.current?.focus();
  }, [editing, board.name]);

  function commit() {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== board.name) void renameBoard(board.boardId, name);
  }

  if (!editable) return <h2 className="truncate text-lg font-semibold text-ink">{board.name}</h2>;
  if (editing) {
    return (
      <input
        aria-label="Board name"
        className="input w-64 max-w-full py-1 text-lg font-semibold"
        value={draft}
        maxLength={MAX_BOARD_NAME_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(board.name);
            setEditing(false);
          }
        }}
        ref={input}
      />
    );
  }
  return (
    <h2 className="truncate text-lg font-semibold text-ink">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to rename"
        aria-label={`Rename board "${board.name}"`}
        className="rounded-md px-1 -mx-1 hover:bg-surface-hover"
      >
        {board.name}
      </button>
    </h2>
  );
}

/** Gear menu next to the board title: rename (its owner), delete (its owner or an admin). */
function BoardMenu({
  board,
  onRename,
  onDelete,
}: Readonly<{ board: Board; onRename?: () => void; onDelete?: () => void }>) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm";
  return (
    <>
      <button
        type="button"
        aria-label={`Board settings for "${board.name}"`}
        title="Board settings"
        aria-expanded={!!anchor}
        aria-haspopup="menu"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
      >
        <SettingsIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div
            role="menu"
            aria-label="Board settings"
            className="w-48 rounded-xl glass-strong border border-white/10 p-1"
          >
            {onRename && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  onRename();
                }}
                className={`${item} text-ink hover:bg-surface-hover`}
              >
                <PencilIcon /> Rename board
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  onDelete();
                }}
                className={`${item} text-error hover:bg-error/10`}
              >
                <TrashIcon /> Delete board
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/** "1 task", "3 tasks". */
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Deleting a board (Phase 32) is destructive and permanent, so it asks for
 * the board's exact name: Delete stays disabled until it's typed. It says
 * what goes with it (tasks, their files, the link from project channels)
 * and, for an admin deleting someone else's board, whose it is.
 */
export function DeleteBoardModal({
  board,
  onClose,
}: Readonly<{ board: Board; onClose: () => void }>) {
  const deleteBoard = useTasks((s) => s.deleteBoard);
  const tasks = useTasks((s) => s.tasksByBoard[board.boardId]);
  const myUserId = useChat((s) => s.me?.userId);
  const projects = useChat(
    useShallow((s) =>
      s.channels.filter((c) => c.linkedBoardId === board.boardId).map((c) => c.name),
    ),
  );
  const nameOf = useNameOf();
  const [typed, setTyped] = useState("");
  const count = tasks?.length ?? 0;
  const files = (tasks ?? []).reduce((n, t) => n + t.attachments.length, 0);
  const matches = typed.trim() === board.name;
  const fieldId = `delete-board-${board.boardId}`;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!matches) return;
    onClose();
    void deleteBoard(board.boardId);
  }

  return (
    <Modal
      title="Delete board"
      width="sm"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form={fieldId + "-form"}
            disabled={!matches}
            className="inline-flex items-center gap-2 rounded-lg bg-error px-4 py-2 text-sm font-semibold text-white hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <TrashIcon aria-hidden="true" />
            Delete board
          </button>
        </>
      }
    >
      <form id={fieldId + "-form"} onSubmit={submit} className="space-y-3 text-sm">
        {board.ownerId !== myUserId && (
          <p className="rounded-lg bg-warning/15 px-3 py-2 text-xs text-ink">
            You&apos;re deleting <strong>{nameOf(board.ownerId)}</strong>&apos;s board as an admin.
          </p>
        )}
        <p className="text-ink">
          <strong>{board.name}</strong> and everything on it disappear for every member:
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-ink-secondary">
          <li>
            {tasks ? plural(count, "task") : "All its tasks"}
            {files > 0 && ` and ${plural(files, "attached file")}`}
          </li>
          {projects.length > 0 && (
            <li>
              The link from {projects.map((n) => `#${n}`).join(", ")} (
              {projects.length === 1 ? "it stays" : "they stay"}, without a board)
            </li>
          )}
        </ul>
        <p className="font-medium text-error">This can&apos;t be undone.</p>
        <div>
          <label htmlFor={fieldId} className="mb-1 block text-ink">
            Type <strong className="select-all font-mono">{board.name}</strong> to confirm
          </label>
          <input
            id={fieldId}
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={typed.length > 0 && !matches}
          />
        </div>
      </form>
    </Modal>
  );
}

/**
 * One board: its header (name, members, sharing) and the three columns.
 * Self-contained (loads its own tasks, never navigates), so it also renders
 * beside a project channel's chat (`compact`: columns in a scrolling strip).
 */
export function BoardView({
  board,
  compact = false,
}: Readonly<{ board: Board; compact?: boolean }>) {
  const myUserId = useChat((s) => s.me?.userId);
  const nameOf = useNameOf();
  const tasks = useTasks((s) => s.tasksByBoard[board.boardId]);
  const loading = useTasks((s) => s.loadingBoard === board.boardId);
  const loadTasks = useTasks((s) => s.loadTasks);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const isOwner = board.ownerId === myUserId;
  const role = useChat((s) => s.me?.role);
  // Phase 32: its owner, or an admin (a board whose owner left would be stuck otherwise).
  const canDelete = !!myUserId && canDeleteBoard(board, myUserId, role);
  const closeTask = useCallback(() => setOpenTaskId(null), []);

  useEffect(() => {
    void loadTasks(board.boardId);
  }, [board.boardId, loadTasks]);

  const { byStatus, archived } = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = { TODO: [], IN_PROGRESS: [], DONE: [] };
    const old: Task[] = [];
    const now = Date.now();
    for (const t of tasks ?? []) {
      if (isTaskArchived(t, now)) old.push(t);
      else (groups[t.status] ?? groups.TODO).push(t);
    }
    // Most recently done first.
    old.sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt));
    return { byStatus: groups, archived: old };
  }, [tasks]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div
        className={`flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 ${
          compact ? "" : "sm:px-6"
        }`}
      >
        <BoardTitle board={board} editable={isOwner} editing={renaming} setEditing={setRenaming} />
        {(isOwner || canDelete) && !renaming && (
          <BoardMenu
            board={board}
            onRename={isOwner ? () => setRenaming(true) : undefined}
            onDelete={canDelete ? () => setDeleting(true) : undefined}
          />
        )}
        <div className="flex items-center -space-x-1" aria-label="Members">
          {board.members.map((id) => (
            <span key={id} title={nameOf(id)} className="rounded-lg ring-2 ring-surface">
              <Avatar name={nameOf(id)} mine={id === myUserId} size="sm" />
            </span>
          ))}
        </div>
        <span className="text-xs text-ink-secondary">
          {board.members.length} member{board.members.length === 1 ? "" : "s"}
          {!isOwner && ` · shared by ${nameOf(board.ownerId)}`}
        </span>
        {isOwner && (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            <UserPlusIcon /> Share board
          </button>
        )}
      </div>

      <div
        className={`min-h-0 w-full flex-1 snap-x snap-mandatory overflow-auto overscroll-x-contain p-4 ${
          compact ? "" : "sm:p-6 md:snap-none"
        }`}
        aria-busy={loading && !tasks}
      >
        {/* Phones and the side pane: columns in a strip, swiped with snapping. md+: three equal columns spanning the area. */}
        <div
          className={
            compact
              ? "flex min-h-full w-max gap-3"
              : "flex min-h-full w-max gap-3 md:grid md:w-full md:min-w-[42rem] md:grid-cols-3 md:items-stretch md:gap-4"
          }
        >
          {COLUMNS.map((column) => (
            <Column
              key={column.status}
              column={column}
              tasks={byStatus[column.status]}
              {...(column.status === "DONE" && {
                archived,
                showArchived,
                onToggleArchived: () => setShowArchived((v) => !v),
              })}
              draggingId={draggingId}
              onDragStart={setDraggingId}
              onOpen={setOpenTaskId}
              onAdd={() => setCreating(true)}
              compact={compact}
            />
          ))}
        </div>
      </div>
      {sharing && <ShareBoardModal board={board} onClose={() => setSharing(false)} />}
      {deleting && <DeleteBoardModal board={board} onClose={() => setDeleting(false)} />}
      {openTaskId && <TaskDetails taskId={openTaskId} board={board} onClose={closeTask} />}
      {creating && <NewTaskModal board={board} onClose={() => setCreating(false)} />}
    </div>
  );
}

// --- Navigation --------------------------------------------------------------------

function BoardList({
  title,
  boards,
  activeId,
}: Readonly<{ title: string; boards: Board[]; activeId: string | undefined }>) {
  const navigate = useNavigate();
  return (
    <section>
      <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        {title}
      </h3>
      <ul className="space-y-0.5">
        {boards.map((b) => (
          <li key={b.boardId}>
            <button
              type="button"
              onClick={() => navigate(boardPath(b.boardId))}
              aria-current={b.boardId === activeId ? "page" : undefined}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                b.boardId === activeId
                  ? "bg-primary/20 font-semibold text-ink"
                  : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
              }`}
            >
              <KanbanIcon className="shrink-0" />
              <span className="truncate">{b.name}</span>
            </button>
          </li>
        ))}
        {boards.length === 0 && <li className="px-2 py-1 text-xs text-ink-secondary">None yet</li>}
      </ul>
    </section>
  );
}

/** Replaces the chat column: board navigation on the left, the Kanban board on the right. */
export function TaskManager({
  boardId,
  onOpenSidebar,
}: Readonly<{
  boardId: string | undefined;
  /** Phones: opens the app sidebar. Absent for guests, who have no sidebar. */
  onOpenSidebar?: () => void;
}>) {
  const navigate = useNavigate();
  const me = useChat((s) => s.me);
  const guest = me?.role === "guest";
  const showToast = useChat((s) => s.showToast);
  const { boards, boardsLoaded, error, loadBoards, clearError } = useTasks(
    useShallow((s) => ({
      boards: s.boards,
      boardsLoaded: s.boardsLoaded,
      error: s.error,
      loadBoards: s.loadBoards,
      clearError: s.clearError,
    })),
  );
  const [creating, setCreating] = useState(false);
  const configured = tasksApiConfigured();

  useEffect(() => {
    if (configured) void loadBoards();
  }, [configured, loadBoards]);

  // Store errors surface as the app's usual toast.
  useEffect(() => {
    if (!error) return;
    showToast(error);
    clearError();
  }, [error, showToast, clearError]);

  const { mine, shared } = useMemo(
    () => splitBoards(boards, me?.userId ?? ""),
    [boards, me?.userId],
  );
  const board = boards.find((b) => b.boardId === boardId);

  // No board picked (or one we can't see any more): open the first one.
  useEffect(() => {
    if (!boardsLoaded || board) return;
    const first = boards[0];
    if (first && (!boardId || boardId !== first.boardId)) {
      navigate(boardPath(first.boardId), { replace: true });
    }
  }, [boardsLoaded, board, boards, boardId, navigate]);

  if (!me) return null;

  let content;
  if (!configured) {
    content = (
      <Empty title="Task Manager isn't set up" text="This deployment has no tasks API URL." />
    );
  } else if (!boardsLoaded) {
    content = <Empty title="Loading boards…" />;
  } else if (boards.length === 0) {
    content = guest ? (
      <Empty
        title="No boards yet"
        text="You'll see a board here as soon as someone invites you to it."
      />
    ) : (
      <Empty title="No boards yet" text="Create a board to start organizing tasks with your team.">
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          <PlusIcon /> New board
        </button>
      </Empty>
    );
  } else if (board && canAccessBoard(board, me.userId)) {
    content = <BoardView key={board.boardId} board={board} />;
  } else {
    content = <Empty title="Opening board…" />;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
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
        <KanbanIcon className="text-ink-secondary" />
        <h1 className="truncate font-semibold text-ink">Task Manager</h1>
        {boards.length > 0 && (
          <label className="ml-auto flex items-center gap-2 text-sm md:hidden">
            <span className="sr-only">Board</span>
            <select
              className="input w-40 py-1.5"
              value={board?.boardId ?? ""}
              onChange={(e) => navigate(boardPath(e.target.value))}
              aria-label="Board"
            >
              {mine.length > 0 && (
                <optgroup label="My boards">
                  {mine.map((b) => (
                    <option key={b.boardId} value={b.boardId}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {shared.length > 0 && (
                <optgroup label="Shared with me">
                  {shared.map((b) => (
                    <option key={b.boardId} value={b.boardId}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
        {configured && !guest && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink md:ml-auto"
            aria-label="New board"
            title="New board"
          >
            <PlusIcon />
            <span className="hidden sm:inline">New board</span>
          </button>
        )}
      </header>

      <div className="flex min-h-0 w-full flex-1">
        {configured && boards.length > 0 && (
          <nav
            aria-label="Boards"
            className="hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface-sidebar p-3 md:flex"
          >
            <BoardList title="My boards" boards={mine} activeId={board?.boardId} />
            <BoardList title="Shared with me" boards={shared} activeId={board?.boardId} />
          </nav>
        )}
        <div className="flex h-full min-w-0 flex-1 flex-col">{content}</div>
      </div>

      {creating && (
        <CreateBoardModal
          onClose={() => setCreating(false)}
          onCreated={(b) => {
            setCreating(false);
            navigate(boardPath(b.boardId));
          }}
        />
      )}
    </div>
  );
}

function Empty({
  title,
  text,
  children,
}: Readonly<{ title: string; text?: string; children?: React.ReactNode }>) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {text && <p className="max-w-sm text-sm text-ink-secondary">{text}</p>}
      {children}
    </div>
  );
}
