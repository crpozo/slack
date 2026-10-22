import { z } from "zod";
import {
  AttachmentSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  UserIdSchema,
  type Attachment,
} from "./protocol";

// ---------------------------------------------------------------------------
// Task Manager (Phase 6): boards shared with members, tasks on a Kanban board.
// Served by the HTTP API (API Gateway v2 + Cognito JWT), not the WebSocket.
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "DONE"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Column titles, as the board shows them. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  DONE: "Done",
};

/**
 * What a board change says in notifications (in-app bell, desktop, Web Push):
 * a new task, or a task moved to another column. Anything else is not announced.
 */
export function describeTaskActivity(change: {
  actorName: string;
  boardName: string;
  task: Pick<Task, "title" | "status">;
  /** Present for a move; absent for a new task. */
  previousStatus?: TaskStatus;
}): { title: string; body: string } {
  const title = change.boardName;
  const what = `“${change.task.title}”`;
  const body =
    change.previousStatus === undefined
      ? `${change.actorName} added ${what} to ${TASK_STATUS_LABEL[change.task.status]}`
      : `${change.actorName} moved ${what} from ${TASK_STATUS_LABEL[change.previousStatus]} to ${TASK_STATUS_LABEL[change.task.status]}`;
  return { title, body };
}

/** The one notification for tasks added together from AI call notes (Phase 29). */
export function describeTasksFromNotes(change: {
  actorName: string;
  boardName: string;
  count: number;
}): { title: string; body: string } {
  const what = change.count === 1 ? "a task" : `${change.count} tasks`;
  return {
    title: change.boardName,
    body: `${change.actorName} added ${what} from ✨ AI call notes to To Do`,
  };
}

export const MAX_BOARD_NAME_LENGTH = 60;
export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MAX_BOARD_MEMBERS = 50;
export const MAX_MEMBERS_PER_REQUEST = 20;
export const MAX_TASK_PROJECT_LENGTH = 40;
export const MAX_TASK_NOTES_LENGTH = 5000;
export const MAX_TASK_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE;

/** Board ids are `b_<ulid>`; used to tell boards from channels in shared code paths (presign). */
export const isBoardId = (id: string) => /^b_[0-9A-Z]{26}$/.test(id);

/** S3 key prefix of a board's files; the presign handler gates it by membership. */
export const attachmentPrefixFor = (boardId: string) => `attachments/${boardId}/`;

export interface Board {
  boardId: string;
  name: string;
  ownerId: string;
  /** Everyone who can see the board, the owner included. */
  members: string[];
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface Task {
  taskId: string;
  boardId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** A board member, or `null` when unassigned. */
  assigneeId: string | null;
  /** Free-text label/tag, e.g. "Website". */
  project: string;
  notes: string;
  /** Files under `attachments/<boardId>/`, downloaded through presigned URLs. */
  attachments: Attachment[];
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** When the task last moved to Done (epoch ms); `null` while it isn't done. */
  doneAt: number | null;
  /**
   * Done for over `ARCHIVE_DONE_AFTER_MS`: hidden from the board unless you
   * ask to see archived tasks. Set by a daily job; moving the task out of
   * Done clears it.
   */
  isArchived: boolean;
}

/** Done tasks are archived after a week. */
export const ARCHIVE_DONE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether `task` is archived at `now`: flagged by the daily job, or past the
 * week already (so the board doesn't wait for the next run).
 */
export function isTaskArchived(
  task: Pick<Task, "status" | "doneAt" | "isArchived">,
  now = Date.now(),
): boolean {
  if (task.status !== "DONE") return false;
  return task.isArchived || (task.doneAt !== null && now - task.doneAt > ARCHIVE_DONE_AFTER_MS);
}

/** Board-level permission: the owner and the members, nobody else. */
export function canAccessBoard(board: Pick<Board, "ownerId" | "members">, userId: string): boolean {
  return board.ownerId === userId || board.members.includes(userId);
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(v), "cannot contain control characters");

export const CreateBoardSchema = z.object({
  name: text(MAX_BOARD_NAME_LENGTH).pipe(z.string().min(1)),
});

/** Rename (owner only). */
export const UpdateBoardSchema = CreateBoardSchema;

/**
 * Board owner invites someone by email. New addresses become guest accounts
 * (Cognito emails them a temporary password); existing accounts are just
 * added to the board.
 */
export const InviteToBoardSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});
export type InviteToBoardInput = z.infer<typeof InviteToBoardSchema>;

export const AddBoardMembersSchema = z.object({
  userIds: z.array(UserIdSchema).min(1).max(MAX_MEMBERS_PER_REQUEST),
});

const attachments = z.array(AttachmentSchema).max(MAX_TASK_ATTACHMENTS);

export const CreateTaskSchema = z.object({
  title: text(MAX_TASK_TITLE_LENGTH).pipe(z.string().min(1)),
  description: text(MAX_TASK_DESCRIPTION_LENGTH).default(""),
  assigneeId: UserIdSchema.nullable().default(null),
  project: text(MAX_TASK_PROJECT_LENGTH).default(""),
  notes: text(MAX_TASK_NOTES_LENGTH).default(""),
  attachments: attachments.default([]),
});

/** Partial update: at least one field. `assigneeId: null` unassigns. */
export const UpdateTaskSchema = z
  .object({
    title: text(MAX_TASK_TITLE_LENGTH).pipe(z.string().min(1)).optional(),
    description: text(MAX_TASK_DESCRIPTION_LENGTH).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    assigneeId: UserIdSchema.nullable().optional(),
    project: text(MAX_TASK_PROJECT_LENGTH).optional(),
    notes: text(MAX_TASK_NOTES_LENGTH).optional(),
    attachments: attachments.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "nothing to update");

export type CreateBoardInput = z.infer<typeof CreateBoardSchema>;
export type AddBoardMembersInput = z.infer<typeof AddBoardMembersSchema>;
export type UpdateBoardInput = z.infer<typeof UpdateBoardSchema>;
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
