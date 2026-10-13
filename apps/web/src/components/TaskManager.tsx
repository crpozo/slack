import {
  canAccessBoard,
  MAX_BOARD_NAME_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_TITLE_LENGTH,
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
import { tasksApiConfigured } from "../lib/tasksApi";
import { useChat, useNameOf } from "../store";
import { splitBoards, useTasks } from "../store/tasks";
import { Avatar } from "./Avatar";
import { CallPanel } from "./CallLayer";
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
import { TaskDetails } from "./TaskDetails";
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

/** The owner adds people from the directory (same picker as DMs and private channels). */
function ShareBoardModal({ board, onClose }: Readonly<{ board: Board; onClose: () => void }>) {
  const addMembers = useTasks((s) => s.addMembers);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shareLabel = selected.length > 0 ? `Share (${selected.length})` : "Share";

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

  return (
    <Modal
      title={`Share "${board.name}"`}
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || selected.length === 0}
            onClick={() => void share()}
          >
            {busy ? "Sharing…" : shareLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Members can see every task on this board and add, move or delete tasks.
        </p>
        <UserPicker
          users={others}
          selected={selected}
          onChange={setSelected}
          locked={board.members}
        />
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

function AddTaskForm({ boardId }: Readonly<{ boardId: string }>) {
  const createTask = useTasks((s) => s.createTask);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  // Focus the title once each time the form opens (never on re-render, which would
  // pull focus back from the description while typing in it).
  useEffect(() => {
    if (open) titleInput.current?.focus();
  }, [open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    void createTask(boardId, t, description.trim());
    setTitle("");
    setDescription("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-ink-secondary hover:border-primary hover:bg-surface-hover hover:text-ink"
      >
        <PlusIcon /> Add task
      </button>
    );
  }
  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-xl border border-primary bg-surface p-3 shadow-sm"
      aria-label="New task"
    >
      <input
        className="input"
        placeholder="What needs to be done?"
        aria-label="Task title"
        value={title}
        maxLength={MAX_TASK_TITLE_LENGTH}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        ref={titleInput}
      />
      <textarea
        className="input min-h-[3.5rem] resize-y"
        placeholder="Details (optional)"
        aria-label="Task description"
        value={description}
        maxLength={MAX_TASK_DESCRIPTION_LENGTH}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <SecondaryButton onClick={() => setOpen(false)}>Cancel</SecondaryButton>
        <button type="submit" className="btn-primary" disabled={!title.trim()}>
          Add
        </button>
      </div>
    </form>
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
            className="w-44 rounded-xl border border-line bg-surface-raised p-1 shadow-xl"
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
      {task.description && (
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs text-ink-secondary">
          {task.description}
        </p>
      )}
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
  boardId,
  draggingId,
  onDragStart,
  onOpen,
}: Readonly<{
  column: (typeof COLUMNS)[number];
  tasks: Task[];
  boardId: string;
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onOpen: (id: string) => void;
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
      className={`flex h-full min-h-[12rem] min-w-0 flex-col rounded-2xl border bg-surface-sidebar p-3 transition-colors ${
        over ? "border-primary bg-primary/10" : "border-line"
      }`}
    >
      <header className="mb-3 flex items-center gap-2 px-1">
        <span className={`h-2.5 w-2.5 rounded-full ${column.accent}`} aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">{column.title}</h3>
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-secondary">
          {tasks.length}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-2">
        {column.status === "TODO" && <AddTaskForm boardId={boardId} />}
        {tasks.map((task) => (
          <TaskCard key={task.taskId} task={task} onDragStart={onDragStart} onOpen={onOpen} />
        ))}
        {tasks.length === 0 && column.status !== "TODO" && (
          <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-ink-secondary">
            Drop tasks here
          </p>
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

/** Owner-only gear menu next to the board title: rename or delete. */
function BoardMenu({
  board,
  onRename,
  onDelete,
}: Readonly<{ board: Board; onRename: () => void; onDelete: () => void }>) {
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
            className="w-48 rounded-xl border border-line bg-surface-raised p-1 shadow-xl"
          >
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
          </div>
        </Popover>
      )}
    </>
  );
}

function DeleteBoardModal({ board, onClose }: Readonly<{ board: Board; onClose: () => void }>) {
  const deleteBoard = useTasks((s) => s.deleteBoard);
  const count = useTasks((s) => s.tasksByBoard[board.boardId]?.length ?? 0);
  return (
    <Modal
      title="Delete board"
      width="sm"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg bg-error px-4 py-2 text-sm font-semibold text-on-accent hover:opacity-90"
            onClick={() => {
              onClose();
              void deleteBoard(board.boardId);
            }}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="text-sm text-ink">
        Delete <strong>{board.name}</strong> and its {count} task{count === 1 ? "" : "s"}? It will
        disappear for every member.
      </p>
      <p className="mt-2 text-xs text-ink-secondary">This can't be undone.</p>
    </Modal>
  );
}

function BoardView({ board }: Readonly<{ board: Board }>) {
  const myUserId = useChat((s) => s.me?.userId);
  const nameOf = useNameOf();
  const tasks = useTasks((s) => s.tasksByBoard[board.boardId]);
  const loading = useTasks((s) => s.loadingBoard === board.boardId);
  const loadTasks = useTasks((s) => s.loadTasks);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const isOwner = board.ownerId === myUserId;
  const closeTask = useCallback(() => setOpenTaskId(null), []);

  useEffect(() => {
    void loadTasks(board.boardId);
  }, [board.boardId, loadTasks]);

  const byStatus = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = { TODO: [], IN_PROGRESS: [], DONE: [] };
    for (const t of tasks ?? []) (groups[t.status] ?? groups.TODO).push(t);
    return groups;
  }, [tasks]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <BoardTitle board={board} editable={isOwner} editing={renaming} setEditing={setRenaming} />
        {isOwner && !renaming && (
          <BoardMenu
            board={board}
            onRename={() => setRenaming(true)}
            onDelete={() => setDeleting(true)}
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

      <div className="min-h-0 w-full flex-1 overflow-auto p-4 sm:p-6" aria-busy={loading && !tasks}>
        {/* Three equal columns spanning the whole chat area; scrolls sideways only on narrow screens. */}
        <div className="grid min-h-full w-full min-w-[42rem] grid-cols-3 items-stretch gap-4">
          {COLUMNS.map((column) => (
            <Column
              key={column.status}
              column={column}
              tasks={byStatus[column.status]}
              boardId={board.boardId}
              draggingId={draggingId}
              onDragStart={setDraggingId}
              onOpen={setOpenTaskId}
            />
          ))}
        </div>
      </div>
      {sharing && <ShareBoardModal board={board} onClose={() => setSharing(false)} />}
      {deleting && <DeleteBoardModal board={board} onClose={() => setDeleting(false)} />}
      {openTaskId && <TaskDetails taskId={openTaskId} board={board} onClose={closeTask} />}
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
}: Readonly<{ boardId: string | undefined; onOpenSidebar: () => void }>) {
  const navigate = useNavigate();
  const me = useChat((s) => s.me);
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
    content = (
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
      <CallPanel channelId="tasks" />
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Open menu"
        >
          <MenuIcon />
        </button>
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
        {configured && (
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
