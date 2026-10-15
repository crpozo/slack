import type { BoardEvent, Task } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const task: Task = {
  taskId: "t_1",
  boardId: "b_1",
  title: "Fix login",
  description: "",
  status: "DONE",
  assigneeId: null,
  project: "",
  notes: "",
  attachments: [],
  createdBy: "u_ana",
  createdAt: 1,
  updatedAt: 2,
};

const sounds = { playMessageSound: vi.fn() };
const desktop = { notifyDesktop: vi.fn().mockResolvedValue(true) };
let active = false;

vi.mock("./sounds", () => sounds);
vi.mock("./desktop", () => desktop);
vi.mock("./activity", () => ({ isAppActive: () => active }));

beforeEach(() => {
  active = false;
  vi.stubGlobal("location", { pathname: "/app/ch_general" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("boardActivity", async () => {
  const { boardActivity } = await import("./alerts");
  const { useChat } = await import("../store");
  useChat.setState({
    users: { u_ana: { userId: "u_ana", email: "ana@x.ec", displayName: "Ana", updatedAt: 0 } },
  });

  it("announces a task someone else created or moved to another column", () => {
    const created: BoardEvent = {
      type: "board.task_created",
      boardId: "b_1",
      task: { ...task, status: "TODO" },
      by: "u_ana",
      boardName: "Website",
    };
    expect(boardActivity(created, "u_me")).toEqual({
      kind: "task",
      title: "Website",
      body: "Ana added “Fix login” to To Do",
      url: "/app/tasks/b_1",
    });
    const moved: BoardEvent = {
      type: "board.task_updated",
      boardId: "b_1",
      task,
      by: "u_ana",
      boardName: "Website",
      previousStatus: "IN_PROGRESS",
    };
    expect(boardActivity(moved, "u_me")?.body).toBe(
      "Ana moved “Fix login” from In Progress to Done",
    );
  });

  it("stays quiet for your own changes, plain edits, deletions and old servers", () => {
    const mine: BoardEvent = { type: "board.task_created", boardId: "b_1", task, by: "u_me" };
    expect(boardActivity(mine, "u_me")).toBeNull();
    const edit: BoardEvent = { type: "board.task_updated", boardId: "b_1", task, by: "u_ana" };
    expect(boardActivity(edit, "u_me")).toBeNull();
    expect(
      boardActivity({ type: "board.task_deleted", boardId: "b_1", taskId: "t_1" }, "u_me"),
    ).toBeNull();
    expect(boardActivity({ type: "board.task_created", boardId: "b_1", task }, "u_me")).toBeNull();
  });
});

describe("raiseAlert", async () => {
  const { raiseAlert } = await import("./alerts");
  const { useNotifications } = await import("../store/notifications");
  const alert = { kind: "task", title: "Website", body: "…", url: "/app/tasks/b_1" } as const;
  beforeEach(() => useNotifications.getState().load("u_me"));

  it("in the background: bell, sound and a desktop notification", () => {
    raiseAlert(alert);
    expect(useNotifications.getState().alerts[0]).toMatchObject({ title: "Website", read: false });
    expect(sounds.playMessageSound).toHaveBeenCalledTimes(1);
    expect(desktop.notifyDesktop).toHaveBeenCalledWith("Website", "…");
  });

  it("in front of another screen: bell and sound, no desktop notification", () => {
    active = true;
    raiseAlert(alert, { sound: false });
    expect(sounds.playMessageSound).not.toHaveBeenCalled();
    expect(desktop.notifyDesktop).not.toHaveBeenCalled();
    expect(useNotifications.getState().alerts[0]?.read).toBe(false);
  });

  it("on that very screen: only a read entry in the bell", () => {
    active = true;
    vi.stubGlobal("location", { pathname: "/app/tasks/b_1" });
    raiseAlert(alert);
    expect(useNotifications.getState().alerts[0]?.read).toBe(true);
    expect(sounds.playMessageSound).not.toHaveBeenCalled();
  });
});
