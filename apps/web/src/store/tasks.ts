import type { Board, BoardEvent, Task, TaskStatus, UpdateTaskInput } from "@mindfultech/shared";
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
  createTask: (boardId: string, title: string, description: string) => Promise<void>;
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

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function createTasksStore(api: TasksApi = tasksApi) {
  return create<TasksState>((set, get) => {
    /** Replaces one task everywhere it appears. */
    const patchTask = (taskId: string, patch: Partial<Task> | ((t: Task) => Task)) =>
      set((s) => ({
        tasksByBoard: Object.fromEntries(
          Object.entries(s.tasksByBoard).map(([boardId, tasks]) => [
            boardId,
            tasks.map((t) =>
              t.taskId === taskId
                ? typeof patch === "function"
                  ? patch(t)
                  : { ...t, ...patch }
                : t,
            ),
          ]),
        ),
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

      async addMembers(boardId, userIds) {
        const board = await api.addMembers(boardId, userIds);
        set((s) => ({ boards: s.boards.map((b) => (b.boardId === boardId ? board : b)) }));
      },

      async createTask(boardId, title, description) {
        const now = Date.now();
        const tempId = `pending_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const optimistic: Task = {
          taskId: tempId,
          boardId,
          title,
          description,
          status: "TODO",
          assigneeId: null,
          project: "",
          notes: "",
          attachments: [],
          createdBy: "",
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          tasksByBoard: {
            ...s.tasksByBoard,
            [boardId]: [...(s.tasksByBoard[boardId] ?? []), optimistic],
          },
        }));
        try {
          const task = await api.createTask(boardId, { title, description });
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
        patchTask(taskId, { status, updatedAt: Date.now() });
        try {
          const task = await api.updateTask(taskId, { status });
          patchTask(taskId, task);
        } catch (err) {
          patchTask(taskId, { status: before.status, updatedAt: before.updatedAt });
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
          const { board } = event;
          set((s) => {
            const mine = board.ownerId === myUserId || board.members.includes(myUserId);
            const known = s.boards.some((b) => b.boardId === board.boardId);
            let boards = s.boards;
            if (!mine) boards = s.boards.filter((b) => b.boardId !== board.boardId);
            else if (known) boards = s.boards.map((b) => (b.boardId === board.boardId ? board : b));
            else boards = [...s.boards, board].sort((a, b) => a.createdAt - b.createdAt);
            return { boards };
          });
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
