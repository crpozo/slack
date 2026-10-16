import type { Board, Task } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import type { TasksApi } from "../lib/tasksApi";
import { createTasksStore, splitBoards } from "./tasks";

const board: Board = {
  boardId: "b_1",
  name: "Launch",
  ownerId: "me",
  members: ["me"],
  createdAt: 1,
};
const task = (id: string, status: Task["status"] = "TODO"): Task => ({
  taskId: id,
  boardId: "b_1",
  title: `Task ${id}`,
  description: "",
  status,
  assigneeId: null,
  project: "",
  notes: "",
  attachments: [],
  createdBy: "me",
  createdAt: 1,
  updatedAt: 1,
  doneAt: status === "DONE" ? 1 : null,
  isArchived: false,
});

/** A controllable fake API: each call returns a promise the test settles. */
function fakeApi() {
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const next = <T>() =>
    new Promise<T>((resolve, reject) => {
      pending.push({ resolve: resolve as (v: unknown) => void, reject });
    });
  const api = {
    listBoards: vi.fn(() => next<Board[]>()),
    createBoard: vi.fn(() => next<Board>()),
    addMembers: vi.fn(() => next<Board>()),
    renameBoard: vi.fn(() => next<Board>()),
    deleteBoard: vi.fn(() => next<void>()),
    listTasks: vi.fn(() => next<Task[]>()),
    createTask: vi.fn(() => next<Task>()),
    updateTask: vi.fn(() => next<Task>()),
    deleteTask: vi.fn(() => next<void>()),
    invite: vi.fn(() =>
      next<{ board: Board; invited: { userId: string; role: "guest"; created: boolean } }>(),
    ),
  } satisfies TasksApi;
  const settle = async (value?: unknown, fail = false) => {
    const p = pending.shift();
    if (!p) throw new Error("nothing pending");
    if (fail) p.reject(value);
    else p.resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { api, settle };
}

async function loaded(tasks: Task[]) {
  const { api, settle } = fakeApi();
  const store = createTasksStore(api);
  const loading = store.getState().loadTasks("b_1");
  await settle(tasks);
  await loading;
  return { api, settle, store };
}

const statusOf = (store: ReturnType<typeof createTasksStore>, id: string) =>
  store.getState().tasksByBoard.b_1?.find((t) => t.taskId === id)?.status;

describe("tasks store", () => {
  it("loads boards and tasks", async () => {
    const { api, settle, store } = await loaded([task("t1")]);
    const p = store.getState().loadBoards();
    await settle([board]);
    await p;
    expect(store.getState().boards).toEqual([board]);
    expect(store.getState().boardsLoaded).toBe(true);
    expect(api.listTasks).toHaveBeenCalledWith("b_1");
    expect(store.getState().tasksByBoard.b_1).toEqual([task("t1")]);
  });

  it("moves a task optimistically and keeps the server's version on success", async () => {
    const { api, settle, store } = await loaded([task("t1")]);
    const move = store.getState().moveTask("t1", "DONE");
    expect(statusOf(store, "t1")).toBe("DONE"); // before the request resolves
    expect(api.updateTask).toHaveBeenCalledWith("t1", { status: "DONE" });

    await settle({ ...task("t1", "DONE"), updatedAt: 99 });
    await move;
    expect(store.getState().tasksByBoard.b_1?.[0]?.updatedAt).toBe(99);
    expect(store.getState().error).toBeNull();
  });

  it("rolls a move back and reports the reason when the request fails", async () => {
    const { settle, store } = await loaded([task("t1", "IN_PROGRESS")]);
    const move = store.getState().moveTask("t1", "DONE");
    expect(statusOf(store, "t1")).toBe("DONE");

    await settle(new Error("Board not found"), true);
    await move;
    expect(statusOf(store, "t1")).toBe("IN_PROGRESS");
    expect(store.getState().error).toBe("Board not found");
  });

  it("moving out of Done unarchives the task at once", async () => {
    const { store } = await loaded([{ ...task("t1", "DONE"), isArchived: true }]);
    void store.getState().moveTask("t1", "TODO");
    expect(store.getState().tasksByBoard.b_1?.[0]).toMatchObject({
      status: "TODO",
      doneAt: null,
      isArchived: false,
    });
  });

  it("does nothing for a move to the same column", async () => {
    const { api, store } = await loaded([task("t1")]);
    await store.getState().moveTask("t1", "TODO");
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("shows a new task at once, then swaps in the saved one", async () => {
    const { api, settle, store } = await loaded([]);
    const input = { title: "Write docs", project: "Docs", assigneeId: "u-a", notes: "soon" };
    const create = store.getState().createTask("b_1", input);
    const optimistic = store.getState().tasksByBoard.b_1?.[0];
    expect(optimistic).toMatchObject({ ...input, status: "TODO", attachments: [] });
    expect(optimistic?.taskId).toMatch(/^pending_/);
    expect(api.createTask).toHaveBeenCalledWith("b_1", input);

    await settle({ ...task("t_real"), title: "Write docs" });
    await create;
    expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t_real"]);
  });

  it("removes a new task again if the server refuses it", async () => {
    const { settle, store } = await loaded([task("t1")]);
    const create = store.getState().createTask("b_1", { title: "Nope" });
    expect(store.getState().tasksByBoard.b_1).toHaveLength(2);
    await settle(new Error("title: too long"), true);
    await create;
    expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t1"]);
    expect(store.getState().error).toBe("title: too long");
  });

  it("deletes optimistically and restores the task in place on failure", async () => {
    const { settle, store } = await loaded([task("t1"), task("t2"), task("t3")]);
    const del = store.getState().deleteTask("t2");
    expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t1", "t3"]);

    await settle(new Error("Task not found"), true);
    await del;
    expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t1", "t2", "t3"]);
    expect(store.getState().error).toBe("Task not found");
  });

  it("creating a board and sharing it update the board list", async () => {
    const { settle, store } = await loaded([]);
    const create = store.getState().createBoard("Roadmap");
    await settle({ ...board, boardId: "b_2", name: "Roadmap" });
    await create;
    expect(store.getState().boards.map((b) => b.boardId)).toEqual(["b_2"]);

    const share = store.getState().addMembers("b_2", ["u2"]);
    await settle({ ...board, boardId: "b_2", name: "Roadmap", members: ["me", "u2"] });
    await share;
    expect(store.getState().boards[0]?.members).toEqual(["me", "u2"]);
  });

  it("renames a board optimistically and rolls back when refused", async () => {
    const { api, settle, store } = await loaded([]);
    const list = store.getState().loadBoards();
    await settle([board]);
    await list;

    const ok = store.getState().renameBoard("b_1", "Launch v2");
    expect(store.getState().boards[0]?.name).toBe("Launch v2");
    expect(api.renameBoard).toHaveBeenCalledWith("b_1", "Launch v2");
    await settle({ ...board, name: "Launch v2" });
    await ok;

    const refused = store.getState().renameBoard("b_1", "Nope");
    expect(store.getState().boards[0]?.name).toBe("Nope");
    await settle(new Error("Only the board owner can rename it"), true);
    await refused;
    expect(store.getState().boards[0]?.name).toBe("Launch v2");
    expect(store.getState().error).toBe("Only the board owner can rename it");
  });

  it("deletes a board optimistically and restores it (with its tasks) when refused", async () => {
    const { api, settle, store } = await loaded([task("t1")]);
    const other = { ...board, boardId: "b_2", createdAt: 2 };
    const list = store.getState().loadBoards();
    await settle([board, other]);
    await list;

    const refused = store.getState().deleteBoard("b_1");
    expect(store.getState().boards.map((b) => b.boardId)).toEqual(["b_2"]);
    expect(store.getState().tasksByBoard.b_1).toBeUndefined();
    expect(api.deleteBoard).toHaveBeenCalledWith("b_1");
    await settle(new Error("Only the board owner can delete it"), true);
    await refused;
    expect(store.getState().boards.map((b) => b.boardId)).toEqual(["b_1", "b_2"]);
    expect(store.getState().tasksByBoard.b_1).toHaveLength(1);
    expect(store.getState().error).toBe("Only the board owner can delete it");

    const ok = store.getState().deleteBoard("b_1");
    await settle(undefined);
    await ok;
    expect(store.getState().boards.map((b) => b.boardId)).toEqual(["b_2"]);
  });

  it("drops a board deleted by its owner (board.deleted push)", async () => {
    const { settle, store } = await loaded([task("t1")]);
    const list = store.getState().loadBoards();
    await settle([board]);
    await list;
    store.getState().applyEvent({ type: "board.deleted", boardId: "b_1" }, "me");
    expect(store.getState().boards).toEqual([]);
    expect(store.getState().tasksByBoard.b_1).toBeUndefined();
  });

  it("splits boards into mine and shared", () => {
    const shared = { ...board, boardId: "b_2", ownerId: "other", members: ["other", "me"] };
    expect(splitBoards([board, shared], "me")).toEqual({ mine: [board], shared: [shared] });
  });

  describe("real-time pushes", () => {
    it("adds, replaces and removes tasks from board.* events, in creation order", async () => {
      const { store } = await loaded([task("t2")]);
      store
        .getState()
        .applyEvent(
          { type: "board.task_created", boardId: "b_1", task: { ...task("t1"), createdAt: 0 } },
          "me",
        );
      expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t1", "t2"]);

      store
        .getState()
        .applyEvent({ type: "board.task_updated", boardId: "b_1", task: task("t2", "DONE") }, "me");
      expect(statusOf(store, "t2")).toBe("DONE");

      store
        .getState()
        .applyEvent({ type: "board.task_updated", boardId: "b_1", task: task("t2", "DONE") }, "me");
      expect(store.getState().tasksByBoard.b_1).toHaveLength(2); // idempotent

      store
        .getState()
        .applyEvent({ type: "board.task_deleted", boardId: "b_1", taskId: "t1" }, "me");
      expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t2"]);
    });

    it("ignores events for boards that were never loaded", async () => {
      const { store } = await loaded([]);
      store
        .getState()
        .applyEvent({ type: "board.task_created", boardId: "b_other", task: task("t9") }, "me");
      expect(store.getState().tasksByBoard.b_other).toBeUndefined();
    });

    it("the actor's own echo arriving before the HTTP response leaves exactly one card", async () => {
      const { settle, store } = await loaded([]);
      const create = store.getState().createTask("b_1", { title: "Echoed" });
      const real = { ...task("t_real"), title: "Echoed" };
      store.getState().applyEvent({ type: "board.task_created", boardId: "b_1", task: real }, "me");
      expect(store.getState().tasksByBoard.b_1).toHaveLength(2); // placeholder + echo, briefly

      await settle(real);
      await create;
      expect(store.getState().tasksByBoard.b_1?.map((t) => t.taskId)).toEqual(["t_real"]);
    });

    it("board.updated adds a board I was just added to, updates known ones and drops ones I left", async () => {
      const { store } = await loaded([]);
      const shared = {
        ...board,
        boardId: "b_2",
        ownerId: "other",
        members: ["other", "me"],
        createdAt: 0,
      };
      store.getState().applyEvent({ type: "board.updated", board: shared }, "me");
      expect(store.getState().boards.map((b) => b.boardId)).toEqual(["b_2"]);

      store
        .getState()
        .applyEvent({ type: "board.updated", board: { ...shared, name: "Renamed" } }, "me");
      expect(store.getState().boards[0]?.name).toBe("Renamed");

      store
        .getState()
        .applyEvent({ type: "board.updated", board: { ...shared, members: ["other"] } }, "me");
      expect(store.getState().boards).toEqual([]);
    });
  });
});
