import type {
  AiNotes,
  Board,
  Channel,
  CreateTaskInput,
  CreateTimeEntryInput,
  PushSubscriptionJSON,
  Role,
  Task,
  TasksFromNotesInput,
  TimeEntry,
  TimeLogResponse,
  UpdateTaskInput,
} from "@mindfultech/shared";
import { getIdToken } from "./auth";

/** A failed request, with the server's message (and its whole answer) when it sent one. */
export class TasksApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: Record<string, unknown>,
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

/**
 * One authenticated call to the HTTP API (shared with the calendar client).
 * A `Blob` body is sent as is, with its own type (Phase 43's audio clips);
 * anything else as JSON.
 */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { keepalive?: boolean; cache?: RequestCache; headers?: Record<string, string> } = {},
): Promise<T> {
  if (!baseUrl) throw new TasksApiError(0, "The Task Manager isn't configured on this deployment.");
  const token = await getIdToken();
  const blob = body instanceof Blob ? body : null;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...options.headers,
        ...(body === undefined ? {} : { "content-type": blob ? blob.type : "application/json" }),
      },
      body: body === undefined ? undefined : (blob ?? JSON.stringify(body)),
      keepalive: options.keepalive,
      cache: options.cache,
    });
  } catch {
    throw new TasksApiError(0, "Couldn't reach the server. Check your connection.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let data: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
        if (typeof data.message === "string") message = data.message;
      }
    } catch {
      // No JSON body: keep the generic message.
    }
    // A 401 with a `code` is the Vault's PIN or lock (Phase 46), not the sign-in.
    if (response.status === 401 && typeof data?.code !== "string") {
      message = "Your session expired. Please sign in again.";
    }
    throw new TasksApiError(response.status, message, data);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** One authenticated GET whose answer is a file (a skill's .zip), as a Blob. */
export async function requestBlob(path: string): Promise<Blob> {
  if (!baseUrl) throw new TasksApiError(0, "The Task Manager isn't configured on this deployment.");
  const token = await getIdToken();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new TasksApiError(0, "Couldn't reach the server. Check your connection.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data.message === "string") message = data.message;
    } catch {
      // Not JSON.
    }
    throw new TasksApiError(response.status, message);
  }
  return response.blob();
}

export const tasksApi = {
  listBoards: () => request<{ boards: Board[] }>("GET", "/boards").then((r) => r.boards),
  createBoard: (name: string) =>
    request<{ board: Board }>("POST", "/boards", { name }).then((r) => r.board),
  renameBoard: (boardId: string, name: string) =>
    request<{ board: Board }>("PUT", `/boards/${encodeURIComponent(boardId)}`, { name }).then(
      (r) => r.board,
    ),
  deleteBoard: (boardId: string) =>
    request<void>("DELETE", `/boards/${encodeURIComponent(boardId)}`),
  /** By email: a new address becomes a guest account (Cognito emails a temporary password). */
  invite: (boardId: string, email: string) =>
    request<{ board: Board; invited: { userId: string; role: Role; created: boolean } }>(
      "POST",
      `/boards/${encodeURIComponent(boardId)}/invites`,
      { email },
    ),
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
  /** An AI notes card's reviewed action items, all at once; 409 if the card was already sent. */
  createFromNotes: (boardId: string, input: TasksFromNotesInput) =>
    request<{ tasks: Task[]; notes: AiNotes }>(
      "POST",
      `/boards/${encodeURIComponent(boardId)}/tasks/from-notes`,
      input,
    ),
};

export type TasksApi = typeof tasksApi;

/** Web Push subscriptions (same HTTP API and auth as the Task Manager). */
export const pushApi = {
  /** 503 while the deployment has no VAPID keys. */
  publicKey: () => request<{ publicKey: string }>("GET", "/push/key").then((r) => r.publicKey),
  subscribe: (subscription: PushSubscriptionJSON) =>
    request<void>("POST", "/push/subscribe", { subscription }),
  unsubscribe: (endpoint: string) => request<void>("DELETE", "/push/subscribe", { endpoint }),
};

/** Channel endpoints of the same HTTP API (Phase 55). */
export const channelsApi = {
  /**
   * Invites someone to a private channel by email. A new address becomes an
   * external (a guest account; Cognito emails a temporary password) who sees
   * only this channel; an existing account is simply added.
   */
  inviteByEmail: (channelId: string, email: string) =>
    request<{ channel: Channel; invited: { userId: string; role: Role; created: boolean } }>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/invites`,
      { email },
    ),
};

/** Hours (Phase 60): a channel's time log. */
export const timeApi = {
  list: (channelId: string) =>
    request<TimeLogResponse>("GET", `/channels/${encodeURIComponent(channelId)}/time`),
  log: (channelId: string, input: CreateTimeEntryInput) =>
    request<{ entry: TimeEntry }>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/time`,
      input,
    ).then((r) => r.entry),
  remove: (entry: Pick<TimeEntry, "channelId" | "date" | "entryId">) =>
    request<void>(
      "DELETE",
      `/channels/${encodeURIComponent(entry.channelId)}/time/${entry.date}/${encodeURIComponent(entry.entryId)}`,
    ),
  /** Admins: someone's hourly rate in this channel, in dollars (0 clears it). */
  setRate: (channelId: string, userId: string, hourlyRate: number) =>
    request<{ userId: string; hourlyRate: number }>(
      "PUT",
      `/channels/${encodeURIComponent(channelId)}/time/rates/${encodeURIComponent(userId)}`,
      { hourlyRate },
    ),
};
