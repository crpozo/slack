import type { Board, CreateTaskInput, Task, UpdateTaskInput } from "@mindfultech/shared";
import { getIdToken } from "./auth";

/** A failed request, with the server's message when it sent one. */
export class TasksApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let baseUrl: string | null = null;

/** Set once from the app config; the client is unusable until then. */
export function configureTasksApi(url: string | null): void {
  baseUrl = url ? url.replace(/\/$/, "") : null;
}

export const tasksApiConfigured = () => baseUrl !== null;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!baseUrl) throw new TasksApiError(0, "The Task Manager isn't configured on this deployment.");
  const token = await getIdToken();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new TasksApiError(0, "Couldn't reach the server. Check your connection.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data: unknown = await response.json();
      if (
        data &&
        typeof data === "object" &&
        typeof (data as { message?: unknown }).message === "string"
      ) {
        message = (data as { message: string }).message;
      }
    } catch {
      // No JSON body: keep the generic message.
    }
    if (response.status === 401) message = "Your session expired. Please sign in again.";
    throw new TasksApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const tasksApi = {
  listBoards: () => request<{ boards: Board[] }>("GET", "/boards").then((r) => r.boards),
  createBoard: (name: string) =>
    request<{ board: Board }>("POST", "/boards", { name }).then((r) => r.board),
  addMembers: (boardId: string, userIds: string[]) =>
    request<{ board: Board }>("POST", `/boards/${encodeURIComponent(boardId)}/members`, {
      userIds,
    }).then((r) => r.board),
  listTasks: (boardId: string) =>
    request<{ tasks: Task[] }>("GET", `/boards/${encodeURIComponent(boardId)}/tasks`).then(
      (r) => r.tasks,
    ),
  createTask: (boardId: string, input: CreateTaskInput) =>
    request<{ task: Task }>("POST", `/boards/${encodeURIComponent(boardId)}/tasks`, input).then(
      (r) => r.task,
    ),
  updateTask: (taskId: string, patch: UpdateTaskInput) =>
    request<{ task: Task }>("PUT", `/tasks/${encodeURIComponent(taskId)}`, patch).then(
      (r) => r.task,
    ),
  deleteTask: (taskId: string) => request<void>("DELETE", `/tasks/${encodeURIComponent(taskId)}`),
};

export type TasksApi = typeof tasksApi;
