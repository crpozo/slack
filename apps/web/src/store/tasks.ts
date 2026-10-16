import type {
  Board,
  BoardEvent,
  CreateTaskInput,
  Role,
  Task,
  TaskStatus,
  UpdateTaskInput,
} from "@mindfultech/shared";
import { create } from "zustand";
import { tasksApi, type TasksApi } from "../lib/tasksApi";

/**
 * Task Manager state. Every mutation is optimistic: the board updates at once,
 * the request runs in the background, and a failure puts things back and
 * reports why. One in-flight request per task at most would be nicer; instead,
 * a later successful response simply wins, which is enough for a 1:1 team.
 */
export interface TasksState {
  boards: Board[];
  boardsLoaded: boolean;
  /** Tasks by board, in creation order; absent until that board was loaded. */
  tasksByBoard: Record<string, Task[]>;
  loadingBoard: string | null;
  error: string | null;

  loadBoards: () => Promise<void>;
  loadTasks: (boardId: string) => Promise<void>;
  createBoard: (name: string) => Promise<Board>;
  addMembers: (boardId: string, userIds: string[]) => Promise<void>;
  /** Owner invites by email; resolves with what happened (a new guest account, or not). */
  invite: (boardId: string, email: string) => Promise<{ role: Role; created: boolean }>;
  /** Optimistic rename; put back with the server's message if refused. */
  renameBoard: (boardId: string, name: string) => Promise<void>;
  /** Owner only; optimistic, restored with an error toast if the server refuses. */
  deleteBoard: (boardId: string) => Promise<void>;
  /** Creates a fully formed task (title required; the rest optional). */
  createTask: (boardId: string, input: CreateTaskInput) => Promise<void>;
  moveTask: (taskId: string, status: TaskStatus) => Promise<void>;
  editTask: (taskId: string, patch: UpdateTaskInput) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  /**
   * A `board.*` push from the server. Applied idempotently (tasks are replaced
   * by id), so the actor's own echo and other members' changes converge.
   */
  applyEvent: (event: BoardEvent, myUserId: string) => void;
  clearError: () => void;
  /** Forgets everything (sign-out). */
  reset: () => void;
}

type TaskPatch = Partial<Task> | ((t: Task) => Task);

const applyPatch = (task: Task, patch: TaskPatch): Task =>
  typeof patch === "function" ? patch(task) : { ...task, ...patch };

const patchList = (tasks: Task[], taskId: string, patch: TaskPatch): Task[] =>
  tasks.map((t) => (t.taskId === taskId ? applyPatch(t, patch) : t));

const mapValues = <T>(record: Record<string, T>, fn: (value: T) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

/** The board list after a `board.updated` push, from the current user's point of view. */
function nextBoards(boards: Board[], board: Board, myUserId: string): Board[] {
  const mine = board.ownerId === myUserId || board.members.includes(myUserId);
  if (!mine) return boards.filter((b) => b.boardId !== board.boardId);
  if (boards.some((b) => b.boardId === board.boardId)) {
    return boards.map((b) => (b.boardId === board.boardId ? board : b));
  }
  return [...boards, board].sort((a, b) => a.createdAt - b.createdAt);
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function createTasksStore(api: TasksApi = tasksApi) {
  return create<TasksState>((set, get) => {
    /** Replaces one task everywhere it appears. */
    const patchTask = (taskId: string, patch: TaskPatch) =>
      set((s) => ({
        tasksByBoard: mapValues(s.tasksByBoard, (tasks) => patchList(tasks, taskId, patch)),
      }));
    const findTask = (taskId: string) =>
      Object.values(get().tasksByBoard)
        .flat()
        .find((t) => t.taskId === taskId);

    return {
      boards: [],
      boardsLoaded: false,
      tasksByBoard: {},
      loadingBoard: null,
      error: null,

      async loadBoards() {
        try {
          const boards = await api.listBoards();
          set({ boards, boardsLoaded: true });
        } catch (err) {
          set({ boardsLoaded: true, error: message(err, "Couldn't load your boards.") });
        }
      },

      async loadTasks(boardId) {
        set({ loadingBoard: boardId });
        try {
          const tasks = await api.listTasks(boardId);
          set((s) => ({ tasksByBoard: { ...s.tasksByBoard, [boardId]: tasks } }));
        } catch (err) {
          set({ error: message(err, "Couldn't load this board.") });
        } finally {
          if (get().loadingBoard === boardId) set({ loadingBoard: null });
        }
      },

      async createBoard(name) {
        const board = await api.createBoard(name); // the modal shows its own error
        set((s) => ({
          boards: [...s.boards, board],
          tasksByBoard: { ...s.tasksByBoard, [board.boardId]: [] },
        }));
        return board;
      },

      async renameBoard(boardId, name) {
        const before = get().boards.find((b) => b.boardId === boardId);
        if (!before || before.name === name) return;
        const rename = (n: string) =>
          set((s) => ({
            boards: s.boards.map((b) => (b.boardId === boardId ? { ...b, name: n } : b)),
          }));
        rename(name);
        try {
          const board = await api.renameBoard(boardId, name);
          set((s) => ({ boards: s.boards.map((b) => (b.boardId === boardId ? board : b)) }));
        } catch (err) {
          rename(before.name);
          set({ error: message(err, "Couldn't rename the board.") });
        }
      },

      async deleteBoard(boardId) {
        const index = get().boards.findIndex((b) => b.boardId === boardId);
        const board = get().boards[index];
        if (!board) return;
        const tasks = get().tasksByBoard[boardId];
        set((s) => ({
          boards: s.boards.filter((b) => b.boardId !== boardId),
          tasksByBoard: omitKey(s.tasksByBoard, boardId),
        }));
        try {
          await api.deleteBoard(boardId);
        } catch (err) {
          set((s) => {
            if (s.boards.some((b) => b.boardId === boardId)) return {};
            const boards = [...s.boards];
            boards.splice(Math.min(index, boards.length), 0, board);
            return {
              boards,
              tasksByBoard: tasks ? { ...s.tasksByBoard, [boardId]: tasks } : s.tasksByBoard,
              error: message(err, "Couldn't delete the board."),
            };
          });
        }
      },

      async addMembers(boardId, userIds) {
        const board = await api.addMembers(boardId, userIds);
        set((s) => ({ boards: s.boards.map((b) => (b.boardId === boardId ? board : b)) }));
      },

      async invite(boardId, email) {
        const { board, invited } = await api.invite(boardId, email);
        set((s) => ({ boards: s.boards.map((b) => (b.boardId === boardId ? board : b)) }));
        return invited;
      },

      async createTask(boardId, input) {
        const now = Date.now();
        const tempId = `pending_${crypto.randomUUID()}`;
        const optimistic: Task = {
          taskId: tempId,
          boardId,
          title: input.title,
          description: input.description ?? "",
          status: "TODO",
          assigneeId: input.assigneeId ?? null,
          project: input.project ?? "",
          notes: input.notes ?? "",
          attachments: input.attachments ?? [],
          createdBy: "",
          createdAt: now,
          updatedAt: now,
          doneAt: null,
          isArchived: false,
        };
        set((s) => ({
          tasksByBoard: {
            ...s.tasksByBoard,
            [boardId]: [...(s.tasksByBoard[boardId] ?? []), optimistic],
          },
        }));
        try {
          const task = await api.createTask(boardId, input);
          set((s) => {
            const list = s.tasksByBoard[boardId] ?? [];
            const echoed = list.some((t) => t.taskId === task.taskId);
            return {
              tasksByBoard: {
                ...s.tasksByBoard,
                [boardId]: echoed
                  ? list.filter((t) => t.taskId !== tempId)
                  : list.map((t) => (t.taskId === tempId ? task : t)),
              },
            };
          });
        } catch (err) {
          set((s) => ({
            tasksByBoard: {
              ...s.tasksByBoard,
              [boardId]: (s.tasksByBoard[boardId] ?? []).filter((t) => t.taskId !== tempId),
            },
            error: message(err, "Couldn't create the task."),
          }));
        }
      },

      async moveTask(taskId, status) {
        const before = findTask(taskId);
        if (!before || before.status === status || before.taskId.startsWith("pending_")) return;
        const now = Date.now();
        // Like the server: into Done starts the archive clock, out of it unarchives.
        patchTask(taskId, {
          status,
          updatedAt: now,
          doneAt: status === "DONE" ? now : null,
          isArchived: false,
        });
        try {
          const task = await api.updateTask(taskId, { status });
          patchTask(taskId, task);
        } catch (err) {
          const { updatedAt, doneAt, isArchived } = before;
          patchTask(taskId, { status: before.status, updatedAt, doneAt, isArchived });
          set({ error: message(err, "Couldn't move the task.") });
        }
      },

      async editTask(taskId, patch) {
        const before = findTask(taskId);
        if (!before || before.taskId.startsWith("pending_")) return;
        patchTask(taskId, { ...patch, updatedAt: Date.now() });
        try {
          const task = await api.updateTask(taskId, patch);
          patchTask(taskId, task);
        } catch (err) {
          patchTask(taskId, before);
          set({ error: message(err, "Couldn't save the task.") });
        }
      },

      async deleteTask(taskId) {
        const before = findTask(taskId);
        if (!before || before.taskId.startsWith("pending_")) return;
        const list = get().tasksByBoard[before.boardId] ?? [];
        const index = list.findIndex((t) => t.taskId === taskId);
        set((s) => ({
          tasksByBoard: {
            ...s.tasksByBoard,
            [before.boardId]: (s.tasksByBoard[before.boardId] ?? []).filter(
              (t) => t.taskId !== taskId,
            ),
          },
        }));
        try {
          await api.deleteTask(taskId);
        } catch (err) {
          set((s) => {
            const current = s.tasksByBoard[before.boardId] ?? [];
            const restored = [...current];
            restored.splice(Math.min(index, restored.length), 0, before);
            return {
              tasksByBoard: { ...s.tasksByBoard, [before.boardId]: restored },
              error: message(err, "Couldn't delete the task."),
            };
          });
        }
      },

      applyEvent(event, myUserId) {
        if (event.type === "board.updated") {
          set((s) => ({ boards: nextBoards(s.boards, event.board, myUserId) }));
          return;
        }
        if (event.type === "board.deleted") {
          set((s) => ({
            boards: s.boards.filter((b) => b.boardId !== event.boardId),
            tasksByBoard: omitKey(s.tasksByBoard, event.boardId),
          }));
          return;
        }
        const { boardId } = event;
        set((s) => {
          const list = s.tasksByBoard[boardId];
          if (!list) return {}; // board not loaded: it will be fetched when opened
          let next: Task[];
          if (event.type === "board.task_deleted") {
            next = list.filter((t) => t.taskId !== event.taskId);
          } else if (list.some((t) => t.taskId === event.task.taskId)) {
            next = list.map((t) => (t.taskId === event.task.taskId ? event.task : t));
          } else {
            next = [...list, event.task].sort((a, b) => a.createdAt - b.createdAt);
          }
          return { tasksByBoard: { ...s.tasksByBoard, [boardId]: next } };
        });
      },

      clearError: () => set({ error: null }),
      reset: () =>
        set({ boards: [], boardsLoaded: false, tasksByBoard: {}, loadingBoard: null, error: null }),
    };
  });
}

export const useTasks = createTasksStore();

/** Boards split the way the navigation shows them. */
export function splitBoards(boards: Board[], myUserId: string) {
  return {
    mine: boards.filter((b) => b.ownerId === myUserId),
    shared: boards.filter((b) => b.ownerId !== myUserId),
  };
}
