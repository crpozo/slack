import { z } from "zod";
import { UserIdSchema } from "./protocol";

// ---------------------------------------------------------------------------
// Task Manager (Phase 6): boards shared with members, tasks on a Kanban board.
// Served by the HTTP API (API Gateway v2 + Cognito JWT), not the WebSocket.
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "DONE"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MAX_BOARD_NAME_LENGTH = 60;
export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MAX_BOARD_MEMBERS = 50;
export const MAX_MEMBERS_PER_REQUEST = 20;

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
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
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

export const AddBoardMembersSchema = z.object({
  userIds: z.array(UserIdSchema).min(1).max(MAX_MEMBERS_PER_REQUEST),
});

export const CreateTaskSchema = z.object({
  title: text(MAX_TASK_TITLE_LENGTH).pipe(z.string().min(1)),
  description: text(MAX_TASK_DESCRIPTION_LENGTH).default(""),
});

/** Partial update: at least one field. */
export const UpdateTaskSchema = z
  .object({
    title: text(MAX_TASK_TITLE_LENGTH).pipe(z.string().min(1)).optional(),
    description: text(MAX_TASK_DESCRIPTION_LENGTH).optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to update");

export type CreateBoardInput = z.infer<typeof CreateBoardSchema>;
export type AddBoardMembersInput = z.infer<typeof AddBoardMembersSchema>;
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
