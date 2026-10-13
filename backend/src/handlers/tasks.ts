import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AddBoardMembersSchema,
  attachmentPrefixFor,
  canAccessBoard,
  CreateBoardSchema,
  CreateTaskSchema,
  MAX_BOARD_MEMBERS,
  UpdateBoardSchema,
  UpdateTaskSchema,
  type Attachment,
  type Board,
  type ServerEvent,
  type Task,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import {
  BOARD_SK,
  boardAudience,
  getAccessibleBoard,
  memberSk,
  toBoard,
  type BoardItem,
} from "../lib/boards";
import { deliver, listConnections } from "../lib/broadcast";
import { batchDelete, ddb, tables } from "../lib/ddb";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { unknownUsers } from "../lib/users";

/**
 * Task Manager HTTP API. Rows of the `boards` table:
 *   - `{ boardId, sk: "BOARD", name, ownerId, members (string set), createdAt }`: the
 *     board, and the single source of truth for who may see it;
 *   - `{ boardId, sk: "MEMBER#<userId>", userId }`: one per member, indexed by user
 *     (`byUser`) so listing someone's boards is a query.
 * Tasks live in their own table keyed by `taskId`, indexed by board (`byBoard`).
 *
 * Every successful write is pushed to the board's members over the chat
 * WebSocket (`board.*` events) so open boards update without a reload: the
 * Lambda scans the live connections and posts to those belonging to members,
 * exactly as the chat handlers broadcast messages.
 */

/** Old rows predate these fields; clients always get the full shape. */
function toTask(item: Record<string, unknown>): Task {
  const t = item as unknown as Task & { attachments?: Attachment[] };
  return {
    ...t,
    assigneeId: t.assigneeId ?? null,
    project: t.project ?? "",
    notes: t.notes ?? "",
    attachments: t.attachments ?? [],
  };
}

/** The board if `caller` may see it; a 404 otherwise, so non-members can't tell it exists. */
async function accessibleBoard(boardId: string, caller: HttpCaller): Promise<Board> {
  const board = await getAccessibleBoard(boardId, caller.userId);
  if (!board) throw notFound("Board not found");
  return board;
}

/**
 * Pushes `event` to every live connection of the board's members. The write
 * already succeeded, so a failed push is logged and never fails the request:
 * a client that reloads sees the right data anyway.
 */
async function notifyBoard(board: Board, event: ServerEvent): Promise<void> {
  try {
    const connections = (await listConnections()).filter(boardAudience(board));
    await deliver(connections, () => event);
  } catch (err) {
    log.error("board broadcast failed", { boardId: board.boardId, ...errorFields(err) });
  }
}

/** Assignee must be on the board; attachments must live under this board's prefix. */
function validateTaskFields(
  board: Board,
  fields: { assigneeId?: string | null; attachments?: Attachment[] },
): void {
  if (fields.assigneeId && !canAccessBoard(board, fields.assigneeId)) {
    throw new HttpError(400, "The assignee must be a member of the board");
  }
  const prefix = attachmentPrefixFor(board.boardId);
  for (const a of fields.attachments ?? []) {
    if (!a.key.startsWith(prefix) || a.key.includes("..")) {
      throw new HttpError(400, "Attachments must be uploaded to this board");
    }
  }
}

// --- Boards ----------------------------------------------------------------------

async function listBoards(caller: HttpCaller): Promise<HttpResult> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: tables.boards,
      IndexName: "byUser",
      KeyConditionExpression: "userId = :me",
      ExpressionAttributeValues: { ":me": caller.userId },
      ProjectionExpression: "boardId",
    }),
  );
  const ids = [...new Set((Items ?? []).map((i) => String(i.boardId)))];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.boards]: { Keys: chunk.map((boardId) => ({ boardId, sk: BOARD_SK })) },
          },
        }),
      ),
    ),
  );
  const boards = pages.flatMap((page) =>
    ((page.Responses?.[tables.boards] ?? []) as BoardItem[]).map(toBoard),
  );
  // Membership rows and the board row agree except mid-change: trust the board row.
  const visible = boards
    .filter((b) => canAccessBoard(b, caller.userId))
    .sort((a, b) => a.createdAt - b.createdAt);
  return json(200, { boards: visible });
}

async function createBoard(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const { name } = parseBody(CreateBoardSchema, event);
  const board: Board = {
    boardId: `b_${ulid()}`,
    name,
    ownerId: caller.userId,
    members: [caller.userId],
    createdAt: Date.now(),
  };
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tables.boards,
            Item: { ...board, sk: BOARD_SK, members: new Set(board.members) },
            ConditionExpression: "attribute_not_exists(boardId)",
          },
        },
        {
          Put: {
            TableName: tables.boards,
            Item: {
              boardId: board.boardId,
              sk: memberSk(caller.userId),
              userId: caller.userId,
              createdAt: board.createdAt,
            },
          },
        },
      ],
    }),
  );
  log.info("board created", { boardId: board.boardId, userId: caller.userId });
  return json(201, { board });
}

async function addMembers(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  const board = await accessibleBoard(boardId, caller);
  if (board.ownerId !== caller.userId) throw forbidden("Only the board owner can add members");

  const { userIds } = parseBody(AddBoardMembersSchema, event);
  const newIds = [...new Set(userIds)].filter((id) => !board.members.includes(id));
  if (newIds.length === 0) return json(200, { board });
  if (board.members.length + newIds.length > MAX_BOARD_MEMBERS) {
    throw new HttpError(400, `A board can have at most ${MAX_BOARD_MEMBERS} members`);
  }
  const missing = await unknownUsers(newIds);
  if (missing.length > 0) throw new HttpError(400, `Unknown users: ${missing.join(", ")}`);

  const now = Date.now();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.boards,
            Key: { boardId, sk: BOARD_SK },
            UpdateExpression: "ADD members :ids",
            ConditionExpression: "ownerId = :me",
            ExpressionAttributeValues: { ":ids": new Set(newIds), ":me": caller.userId },
          },
        },
        ...newIds.map((userId) => ({
          Put: {
            TableName: tables.boards,
            Item: { boardId, sk: memberSk(userId), userId, createdAt: now },
          },
        })),
      ],
    }),
  );
  log.info("members added", { boardId, userId: caller.userId, added: newIds.length });
  const updated: Board = {
    ...board,
    members: [...board.members, ...newIds].sort((a, b) => a.localeCompare(b)),
  };
  // Old and new members alike: the new ones gain the board in their list right away.
  await notifyBoard(updated, { type: "board.updated", board: updated });
  return json(200, { board: updated });
}

async function renameBoard(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  const board = await accessibleBoard(boardId, caller);
  if (board.ownerId !== caller.userId) throw forbidden("Only the board owner can rename it");
  const { name } = parseBody(UpdateBoardSchema, event);
  await ddb.send(
    new UpdateCommand({
      TableName: tables.boards,
      Key: { boardId, sk: BOARD_SK },
      UpdateExpression: "SET #name = :name",
      ConditionExpression: "ownerId = :me",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": name, ":me": caller.userId },
    }),
  );
  log.info("board renamed", { boardId, userId: caller.userId });
  const updated: Board = { ...board, name };
  await notifyBoard(updated, { type: "board.updated", board: updated });
  return json(200, { board: updated });
}

/**
 * Owner only. Cascades: every task first, then the membership rows, then the
 * board row last — if anything fails part way the board is still there (and
 * still owned) to retry. Members get `board.deleted`.
 */
async function deleteBoard(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  const board = await accessibleBoard(boardId, caller);
  if (board.ownerId !== caller.userId) throw forbidden("Only the board owner can delete it");

  const tasks = await queryBoardTasks(boardId);
  await batchDelete(
    tables.tasks,
    tasks.map((t) => ({ taskId: t.taskId })),
  );
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: tables.boards,
      KeyConditionExpression: "boardId = :b",
      ExpressionAttributeValues: { ":b": boardId },
      ProjectionExpression: "boardId, sk",
    }),
  );
  const memberRows = (Items ?? []).filter((i) => i.sk !== BOARD_SK);
  await batchDelete(
    tables.boards,
    memberRows.map((i) => ({ boardId, sk: i.sk })),
  );
  await ddb.send(
    new DeleteCommand({
      TableName: tables.boards,
      Key: { boardId, sk: BOARD_SK },
      ConditionExpression: "ownerId = :me",
      ExpressionAttributeValues: { ":me": caller.userId },
    }),
  );
  log.info("board deleted", { boardId, userId: caller.userId, tasks: tasks.length });
  await notifyBoard(board, { type: "board.deleted", boardId });
  return json(204);
}

// --- Tasks -----------------------------------------------------------------------

/** Every task of a board, following the index's pagination. */
async function queryBoardTasks(
  boardId: string,
  startKey?: Record<string, unknown>,
): Promise<Task[]> {
  const page = await ddb.send(
    new QueryCommand({
      TableName: tables.tasks,
      IndexName: "byBoard",
      KeyConditionExpression: "boardId = :b",
      ExpressionAttributeValues: { ":b": boardId },
      ExclusiveStartKey: startKey,
    }),
  );
  const items = (page.Items ?? []).map(toTask);
  if (!page.LastEvaluatedKey) return items;
  return [...items, ...(await queryBoardTasks(boardId, page.LastEvaluatedKey))];
}

async function listTasks(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  await accessibleBoard(boardId, caller);
  const tasks = await queryBoardTasks(boardId);
  return json(200, { tasks });
}

async function createTask(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  const board = await accessibleBoard(boardId, caller);
  const input = parseBody(CreateTaskSchema, event);
  validateTaskFields(board, input);
  const now = Date.now();
  const task: Task = {
    taskId: `t_${ulid()}`,
    boardId,
    title: input.title,
    description: input.description,
    status: "TODO",
    assigneeId: input.assigneeId,
    project: input.project,
    notes: input.notes,
    attachments: input.attachments,
    createdBy: caller.userId,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(
    new PutCommand({
      TableName: tables.tasks,
      Item: task,
      ConditionExpression: "attribute_not_exists(taskId)",
    }),
  );
  log.info("task created", { boardId, taskId: task.taskId, userId: caller.userId });
  await notifyBoard(board, { type: "board.task_created", boardId, task });
  return json(201, { task });
}

/** The task and its board if the board is accessible to `caller`; a 404 otherwise. */
async function accessibleTask(
  taskId: string,
  caller: HttpCaller,
): Promise<{ task: Task; board: Board }> {
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.tasks, Key: { taskId } }));
  if (!Item) throw notFound("Task not found");
  const task = toTask(Item);
  const board = await getAccessibleBoard(task.boardId, caller.userId);
  if (!board) throw notFound("Task not found");
  return { task, board };
}

async function updateTask(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const taskId = pathParam(event, "taskId");
  const { board } = await accessibleTask(taskId, caller);
  const patch = parseBody(UpdateTaskSchema, event);
  validateTaskFields(board, patch);

  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":updatedAt": Date.now() };
  const sets = ["#updatedAt = :updatedAt"];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.tasks,
      Key: { taskId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(taskId)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  const task = toTask(Attributes ?? {});
  log.info("task updated", { taskId, userId: caller.userId, fields: Object.keys(patch) });
  await notifyBoard(board, { type: "board.task_updated", boardId: board.boardId, task });
  return json(200, { task });
}

async function deleteTask(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const taskId = pathParam(event, "taskId");
  const { board } = await accessibleTask(taskId, caller);
  await ddb.send(new DeleteCommand({ TableName: tables.tasks, Key: { taskId } }));
  log.info("task deleted", { taskId, userId: caller.userId });
  await notifyBoard(board, { type: "board.task_deleted", boardId: board.boardId, taskId });
  return json(204);
}

// --- Router ----------------------------------------------------------------------

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /boards": (_e, c) => listBoards(c),
  "POST /boards": createBoard,
  "PUT /boards/{id}": renameBoard,
  "DELETE /boards/{id}": deleteBoard,
  "POST /boards/{id}/members": addMembers,
  "GET /boards/{id}/tasks": listTasks,
  "POST /boards/{id}/tasks": createTask,
  "PUT /tasks/{taskId}": updateTask,
  "DELETE /tasks/{taskId}": deleteTask,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
