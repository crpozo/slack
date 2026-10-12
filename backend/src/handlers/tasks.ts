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
  canAccessBoard,
  CreateBoardSchema,
  CreateTaskSchema,
  MAX_BOARD_MEMBERS,
  UpdateTaskSchema,
  type Board,
  type Task,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { ddb, tables } from "../lib/ddb";
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
import { log } from "../lib/logger";
import { unknownUsers } from "../lib/users";

/**
 * Task Manager HTTP API. Rows of the `boards` table:
 *   - `{ boardId, sk: "BOARD", name, ownerId, members (string set), createdAt }`: the
 *     board, and the single source of truth for who may see it;
 *   - `{ boardId, sk: "MEMBER#<userId>", userId }`: one per member, indexed by user
 *     (`byUser`) so listing someone's boards is a query.
 * Tasks live in their own table keyed by `taskId`, indexed by board (`byBoard`).
 */

const BOARD_SK = "BOARD";
const memberSk = (userId: string) => `MEMBER#${userId}`;

type BoardItem = Omit<Board, "members"> & { sk: string; members?: Set<string> | string[] };

function toBoard(item: BoardItem): Board {
  return {
    boardId: item.boardId,
    name: item.name,
    ownerId: item.ownerId,
    createdAt: item.createdAt,
    members: [...(item.members ?? [])].sort((a, b) => a.localeCompare(b)),
  };
}

/** The board if `caller` may see it; a 404 otherwise, so non-members can't tell it exists. */
async function accessibleBoard(boardId: string, caller: HttpCaller): Promise<Board> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.boards, Key: { boardId, sk: BOARD_SK } }),
  );
  if (!Item) throw notFound("Board not found");
  const board = toBoard(Item as BoardItem);
  if (!canAccessBoard(board, caller.userId)) throw notFound("Board not found");
  return board;
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
  const boards: Board[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { Responses } = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [tables.boards]: {
            Keys: ids.slice(i, i + 100).map((boardId) => ({ boardId, sk: BOARD_SK })),
          },
        },
      }),
    );
    boards.push(...((Responses?.[tables.boards] ?? []) as BoardItem[]).map(toBoard));
  }
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
  const members = [...board.members, ...newIds].sort((a, b) => a.localeCompare(b));
  return json(200, { board: { ...board, members } });
}

// --- Tasks -----------------------------------------------------------------------

async function listTasks(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  await accessibleBoard(boardId, caller);
  const tasks: Task[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tables.tasks,
        IndexName: "byBoard",
        KeyConditionExpression: "boardId = :b",
        ExpressionAttributeValues: { ":b": boardId },
        ExclusiveStartKey,
      }),
    );
    tasks.push(...((page.Items ?? []) as Task[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return json(200, { tasks });
}

async function createTask(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  await accessibleBoard(boardId, caller);
  const input = parseBody(CreateTaskSchema, event);
  const now = Date.now();
  const task: Task = {
    taskId: `t_${ulid()}`,
    boardId,
    title: input.title,
    description: input.description,
    status: "TODO",
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
  return json(201, { task });
}

/** The task if its board is accessible to `caller`; a 404 otherwise. */
async function accessibleTask(taskId: string, caller: HttpCaller): Promise<Task> {
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.tasks, Key: { taskId } }));
  if (!Item) throw notFound("Task not found");
  const task = Item as Task;
  try {
    await accessibleBoard(task.boardId, caller);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw notFound("Task not found");
    throw err;
  }
  return task;
}

async function updateTask(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const taskId = pathParam(event, "taskId");
  await accessibleTask(taskId, caller);
  const patch = parseBody(UpdateTaskSchema, event);

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
  log.info("task updated", { taskId, userId: caller.userId, fields: Object.keys(patch) });
  return json(200, { task: Attributes as Task });
}

async function deleteTask(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const taskId = pathParam(event, "taskId");
  await accessibleTask(taskId, caller);
  await ddb.send(new DeleteCommand({ TableName: tables.tasks, Key: { taskId } }));
  log.info("task deleted", { taskId, userId: caller.userId });
  return json(204);
}

// --- Router ----------------------------------------------------------------------

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /boards": (_e, c) => listBoards(c),
  "POST /boards": createBoard,
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
