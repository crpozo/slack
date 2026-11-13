import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  AddBoardMembersSchema,
  attachmentPrefixFor,
  canAccessBoard,
  canDeleteBoard,
  canManageMembers,
  compareIds,
  CreateBoardSchema,
  CreateTaskSchema,
  InviteByEmailSchema,
  InviteToBoardSchema,
  MAX_BOARD_MEMBERS,
  TASK_AI_PHASES,
  TASK_AI_SUMMARY_MAX,
  taskAiBusy,
  taskProvenance,
  TasksFromNotesSchema,
  UpdateBoardSchema,
  UpdateTaskSchema,
  type AiNotes,
  type Attachment,
  type Board,
  type MessageUpdatedEvent,
  type NotesSentToBoard,
  type ServerEvent,
  type Task,
  type TaskAi,
  type TaskAiUpdate,
  type TaskStatus,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import {
  BOARD_SK,
  boardAudience,
  boardRows,
  boardsOf,
  getAccessibleBoard,
  getLiveBoard,
  memberSk,
} from "../lib/boards";
import { activeUserIds, deliver, listConnections, type LiveConnection } from "../lib/broadcast";
import { speakerNames } from "../lib/callNotes";
import { channelAudience, getAccessibleChannel, scanChannels, visibleTo } from "../lib/channels";
import { purgeBoard, type PurgeReport } from "../lib/boardDeletion";
import { ddb, tables } from "../lib/ddb";
import { optionalSecret } from "../lib/secret";
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
import { findOrInviteGuest, type InvitedAccount } from "../lib/cognito";
import { notifyTaskActivity, notifyTasksFromNotes } from "../lib/notify";
import { defaultDisplayName, toUserProfile, unknownUsers } from "../lib/users";

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
    // Done before `doneAt` existed: it's been done since its last change at the latest.
    doneAt: t.doneAt ?? (t.status === "DONE" ? t.updatedAt : null),
    isArchived: t.isArchived ?? false,
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
async function notifyBoard(board: Board, event: ServerEvent): Promise<LiveConnection[]> {
  try {
    const connections = await listConnections();
    await deliver(connections.filter(boardAudience(board)), () => event);
    return connections;
  } catch (err) {
    log.error("board broadcast failed", { boardId: board.boardId, ...errorFields(err) });
    return [];
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
  return json(200, { boards: await boardsOf(caller.userId) });
}

async function createBoard(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  if (caller.role === "guest") throw forbidden("Guests can't create boards");
  const { name } = parseBody(CreateBoardSchema, event);
  const board: Board = {
    boardId: `b_${ulid()}`,
    name,
    ownerId: caller.userId,
    members: [caller.userId],
    createdAt: Date.now(),
  };
  await ddb.send(new TransactWriteCommand({ TransactItems: boardRows(board) }));
  log.info("board created", { boardId: board.boardId, userId: caller.userId });
  return json(201, { board });
}

/** The board for its owner (and never for a guest, who can't own boards); 403/404 otherwise. */
async function ownedBoard(boardId: string, caller: HttpCaller, what: string): Promise<Board> {
  const board = await accessibleBoard(boardId, caller);
  if (board.ownerId !== caller.userId || caller.role === "guest") {
    throw forbidden(`Only the board owner can ${what}`);
  }
  return board;
}

/**
 * Adds `userIds` (who must exist in `users`) to the owner's board: the board
 * row is the authority (`ADD members`), plus one membership row each. Old and
 * new members alike hear `board.updated` (the new ones gain the board).
 */
async function addToBoard(board: Board, userIds: string[], caller: HttpCaller): Promise<Board> {
  const newIds = [...new Set(userIds)].filter((id) => !board.members.includes(id));
  if (newIds.length === 0) return board;
  if (board.members.length + newIds.length > MAX_BOARD_MEMBERS) {
    throw new HttpError(400, `A board can have at most ${MAX_BOARD_MEMBERS} members`);
  }
  const now = Date.now();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.boards,
            Key: { boardId: board.boardId, sk: BOARD_SK },
            UpdateExpression: "ADD members :ids",
            ConditionExpression: "ownerId = :me",
            ExpressionAttributeValues: { ":ids": new Set(newIds), ":me": caller.userId },
          },
        },
        ...newIds.map((userId) => ({
          Put: {
            TableName: tables.boards,
            Item: { boardId: board.boardId, sk: memberSk(userId), userId, createdAt: now },
          },
        })),
      ],
    }),
  );
  log.info("members added", {
    boardId: board.boardId,
    userId: caller.userId,
    added: newIds.length,
  });
  const updated: Board = {
    ...board,
    members: [...board.members, ...newIds].sort((a, b) => a.localeCompare(b)),
  };
  await notifyBoard(updated, { type: "board.updated", board: updated });
  return updated;
}

async function addMembers(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const board = await ownedBoard(pathParam(event, "id"), caller, "add members");
  const { userIds } = parseBody(AddBoardMembersSchema, event);
  const missing = await unknownUsers(
    [...new Set(userIds)].filter((id) => !board.members.includes(id)),
  );
  if (missing.length > 0) throw new HttpError(400, `Unknown users: ${missing.join(", ")}`);
  return json(200, { board: await addToBoard(board, userIds, caller) });
}

/**
 * Invites someone to the board by email. A new address becomes a guest
 * account (Cognito emails a temporary password; they see only the boards they
 * are invited to); an existing account is simply added. Owner only.
 */
/**
 * The invited person's directory row, written now so boards and channels show
 * their name (and, for an external, that they are one) before they ever sign
 * in. The team's open apps get it at once (`user.updated`; never a guest's).
 */
async function saveInvitedProfile(account: InvitedAccount): Promise<void> {
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId: account.userId },
      UpdateExpression:
        "SET email = :email, #role = :role, displayName = if_not_exists(displayName, :name), " +
        "createdAt = if_not_exists(createdAt, :now), updatedAt = if_not_exists(updatedAt, :now)",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: {
        ":email": account.email,
        ":role": account.role,
        ":name": defaultDisplayName(account.email),
        ":now": Date.now(),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  if (!account.created || !Attributes) return;
  try {
    const user = toUserProfile(Attributes);
    const team = (await listConnections()).filter((c) => c.role !== "guest");
    await deliver(team, () => ({ type: "user.updated", user }));
  } catch (err) {
    log.warn("invited profile not announced", { userId: account.userId, ...errorFields(err) });
  }
}

async function inviteToBoard(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const board = await ownedBoard(pathParam(event, "id"), caller, "invite people");
  const { email } = parseBody(InviteToBoardSchema, event);
  if (board.members.length >= MAX_BOARD_MEMBERS) {
    throw new HttpError(400, `A board can have at most ${MAX_BOARD_MEMBERS} members`);
  }
  const account = await findOrInviteGuest(email);
  await saveInvitedProfile(account);
  log.info("board invite", {
    boardId: board.boardId,
    userId: caller.userId,
    role: account.role,
    created: account.created,
  });
  const updated = await addToBoard(board, [account.userId], caller);
  return json(200, {
    board: updated,
    invited: { userId: account.userId, role: account.role, created: account.created },
  });
}

/**
 * Invites someone to a private channel by email (Phase 55). An address with
 * no account becomes an external: a guest account (Cognito emails the
 * temporary password) that sees this channel, and whatever else they're
 * invited to, and nothing more of the team's. An existing account (a team
 * member, or an external already) is simply added. The channel's creator or
 * an admin in it, as for inviting from the team (`canManageMembers`).
 */
async function inviteToChannel(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  if (caller.role === "guest") throw forbidden("Guests can't invite people");
  const channelId = decodeURIComponent(pathParam(event, "channelId"));
  const { email } = parseBody(InviteByEmailSchema, event);
  const channel = await getAccessibleChannel(channelId, caller);
  if (!channel || channel.archived) throw notFound("Channel not found");
  if (channel.type !== "private") {
    throw new HttpError(400, "Only private channels take invitations");
  }
  if (!canManageMembers(channel, caller.userId, caller.role)) {
    throw forbidden("Only the channel creator or an admin can invite people");
  }
  const account = await findOrInviteGuest(email);
  await saveInvitedProfile(account);
  const members = [...new Set([...(channel.members ?? []), account.userId])].sort(compareIds);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.channels,
        Key: { channelId: channel.channelId },
        // Appended to whatever the list is now (another invite may have just landed).
        UpdateExpression: "SET members = list_append(members, :new)",
        ConditionExpression: "#type = :private AND NOT contains(members, :id)",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: {
          ":new": [account.userId],
          ":id": account.userId,
          ":private": "private",
        },
      }),
    );
  } catch (err) {
    // Already in it: nothing to add (the account may still have been re-sent its email).
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  log.info("channel invite", {
    channelId: channel.channelId,
    userId: caller.userId,
    role: account.role,
    created: account.created,
  });
  // Everyone's list again, each filtered (the external now sees this channel).
  try {
    const all = await scanChannels();
    await deliver(await listConnections(), (connection) => ({
      type: "channel.list",
      channels: visibleTo(all, connection.userId, connection.role),
    }));
  } catch (err) {
    log.error("channel list broadcast failed", { channelId, ...errorFields(err) });
  }
  return json(200, {
    channel: { ...channel, members },
    invited: { userId: account.userId, role: account.role, created: account.created },
  });
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
/**
 * `DELETE /boards/{id}` (Phase 32): its owner, or an admin (whether or not
 * they're on it), deletes a board and everything on it. The board row is
 * stamped `deletingAt` first, so it's gone for every route at once and
 * nothing new can land on it; the members hear `board.deleted`; then its
 * tasks, files, project-channel links and membership rows are removed, and
 * the board row last. 204 when all of that finished, 202 when the cleanup
 * was interrupted (the daily sweep finishes it; the board is gone either way).
 */
async function deleteBoard(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  const board =
    caller.role === "admin"
      ? await getLiveBoard(boardId)
      : await getAccessibleBoard(boardId, caller.userId);
  if (!board) throw notFound("Board not found");
  if (!canDeleteBoard(board, caller.userId, caller.role)) {
    throw forbidden("Only the board's owner or an admin can delete it");
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.boards,
        Key: { boardId, sk: BOARD_SK },
        UpdateExpression: "SET deletingAt = :now",
        ConditionExpression: "attribute_exists(boardId) AND attribute_not_exists(deletingAt)",
        ExpressionAttributeValues: { ":now": Date.now() },
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      throw notFound("Board not found"); // deleted (or being deleted) by someone else
    }
    throw err;
  }
  log.info("board deleting", {
    boardId,
    userId: caller.userId,
    byAdmin: board.ownerId !== caller.userId,
  });
  const connections = await notifyBoard(board, { type: "board.deleted", boardId });

  let report: PurgeReport;
  try {
    report = await purgeBoard(boardId);
  } catch (err) {
    log.error("board cleanup interrupted; the daily sweep finishes it", {
      boardId,
      ...errorFields(err),
    });
    return json(202, {
      message: "The board is deleted; its tasks and files are still being removed.",
    });
  }
  // Project channels that pointed at it: everyone who sees them gets the unlinked channel.
  if (report.channels.length > 0) {
    try {
      const live = connections.length > 0 ? connections : await listConnections();
      await Promise.all(
        report.channels.map((channel) =>
          deliver(live.filter(channelAudience(channel)), () => ({
            type: "channel.updated",
            channel,
          })),
        ),
      );
    } catch (err) {
      log.error("unlinked channels not announced", { boardId, ...errorFields(err) });
    }
  }
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
    doneAt: null,
    isArchived: false,
  };
  await ddb.send(
    new PutCommand({
      TableName: tables.tasks,
      Item: task,
      ConditionExpression: "attribute_not_exists(taskId)",
    }),
  );
  log.info("task created", { boardId, taskId: task.taskId, userId: caller.userId });
  const connections = await notifyBoard(board, {
    type: "board.task_created",
    boardId,
    task,
    by: caller.userId,
    boardName: board.name,
  });
  await notifyTaskActivity(board, caller, task, undefined, activeUserIds(connections));
  return json(201, { task });
}

/**
 * `POST /boards/{id}/tasks/from-notes` (Phase 29): the action items of an AI
 * notes card, reviewed by the person, become tasks in To Do. One transaction
 * writes every task and stamps the card `sentToBoard` (only if it isn't
 * already), so a notes card reaches a board once, whole or not at all, from
 * either person and any device. The board updates live task by task; its
 * members get one notification for the batch; the card shows where its
 * items went (`message.updated`).
 */
async function createTasksFromNotes(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const boardId = pathParam(event, "id");
  const board = await accessibleBoard(boardId, caller);
  const input = parseBody(TasksFromNotesSchema, event);
  for (const draft of input.tasks) validateTaskFields(board, draft);

  const channel = await getAccessibleChannel(input.channelId, caller, {
    allowArchived: true,
  });
  const { Item } = channel
    ? await ddb.send(
        new GetCommand({
          TableName: tables.messages,
          Key: { channelId: input.channelId, sk: input.sk },
        }),
      )
    : { Item: undefined };
  const notes = Item?.kind === "ai_notes" ? (Item.aiNotes as AiNotes | undefined) : undefined;
  if (!channel || !Item || !notes) throw notFound("Notes not found");
  if (notes.status !== "ready") throw new HttpError(409, "These notes aren't ready yet");
  if (notes.sentToBoard) {
    throw new HttpError(409, `Already sent to ${notes.sentToBoard.boardName}`);
  }

  const peer = notes.participants.find((id) => id !== caller.userId) ?? caller.userId;
  const peerName = (await speakerNames([peer]))[peer] ?? "someone";
  const provenance = taskProvenance(peerName, notes.startedAt, notes.endedAt);
  const now = Date.now();
  const tasks: Task[] = input.tasks.map((draft, i) => ({
    taskId: `t_${ulid(now)}`,
    boardId,
    title: draft.title,
    description: draft.description,
    status: "TODO",
    assigneeId: draft.assigneeId,
    project: "",
    notes: provenance,
    attachments: [],
    createdBy: caller.userId,
    // A millisecond apart: the board lists them in the notes' order.
    createdAt: now + i,
    updatedAt: now + i,
    doneAt: null,
    isArchived: false,
  }));
  const sent: NotesSentToBoard = {
    boardId,
    boardName: board.name,
    count: tasks.length,
    by: caller.userId,
    at: now,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tables.messages,
              Key: { channelId: input.channelId, sk: input.sk },
              UpdateExpression: "SET aiNotes.sentToBoard = :sent",
              ConditionExpression:
                "kind = :kind AND aiNotes.#status = :ready AND attribute_not_exists(aiNotes.sentToBoard)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":sent": sent, ":kind": "ai_notes", ":ready": "ready" },
            },
          },
          ...tasks.map((task) => ({
            Put: {
              TableName: tables.tasks,
              Item: task,
              ConditionExpression: "attribute_not_exists(taskId)",
            },
          })),
        ],
      }),
    );
  } catch (err) {
    const claim = err instanceof TransactionCanceledException ? err.CancellationReasons?.[0] : null;
    if (claim?.Code === "ConditionalCheckFailed") {
      // Sent from the other person's app (or another tab) a moment ago.
      throw new HttpError(409, "These action items were already sent to a board");
    }
    throw err;
  }
  log.info("tasks created from notes", {
    boardId,
    channelId: input.channelId,
    count: tasks.length,
    userId: caller.userId,
  });

  const updated: AiNotes = { ...notes, sentToBoard: sent };
  let connections: LiveConnection[] = [];
  try {
    connections = await listConnections();
    const toBoard = connections.filter(boardAudience(board));
    for (const [index, task] of tasks.entries()) {
      await deliver(toBoard, () => ({
        type: "board.task_created",
        boardId,
        task,
        by: caller.userId,
        boardName: board.name,
        batch: { index, size: tasks.length },
      }));
    }
    const inConversation = channelAudience(channel);
    const cardUpdate: MessageUpdatedEvent = {
      type: "message.updated",
      channelId: input.channelId,
      sk: input.sk,
      messageId: String(Item.messageId),
      text: String(Item.text),
      aiNotes: updated,
    };
    await deliver(connections.filter(inConversation), () => cardUpdate);
  } catch (err) {
    log.error("tasks-from-notes broadcast failed", { boardId, ...errorFields(err) });
  }
  await notifyTasksFromNotes(board, caller, tasks.length, activeUserIds(connections));
  return json(201, { tasks, notes: updated });
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
  const { task: before, board } = await accessibleTask(taskId, caller);
  const patch = parseBody(UpdateTaskSchema, event);
  validateTaskFields(board, patch);

  const now = Date.now();
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":updatedAt": now };
  const sets = ["#updatedAt = :updatedAt"];
  const assign = (key: string, value: unknown) => {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) assign(key, value);
  }
  // Moving into Done starts the archive clock; moving out stops it and unarchives.
  if (patch.status && patch.status !== before.status) {
    assign("doneAt", patch.status === "DONE" ? now : null);
    assign("isArchived", false);
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
  // A move to another column is announced; other edits only refresh open boards.
  const previousStatus = task.status !== before.status ? before.status : undefined;
  const connections = await notifyBoard(board, {
    type: "board.task_updated",
    boardId: board.boardId,
    task,
    by: caller.userId,
    boardName: board.name,
    ...(previousStatus && { previousStatus }),
  });
  if (previousStatus) {
    await notifyTaskActivity(board, caller, task, previousStatus, activeUserIds(connections));
  }
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

// --- Tasks done by the AI (Phase 65) -----------------------------------------------

const githubActionsToken = optionalSecret("GITHUB_ACTIONS_TOKEN", "GITHUB_ACTIONS_TOKEN_PARAMETER");
let aiFetch: typeof fetch = fetch;
/** Tests: a fake GitHub. */
export function useAiTaskFetch(fake: typeof fetch = fetch): void {
  aiFetch = fake;
}

/** Writes `ai` (and a column move, if any) on the task and tells the board. */
async function setTaskAi(
  board: Board,
  before: Task,
  ai: TaskAi,
  status: TaskStatus,
  by: string,
): Promise<Task> {
  const now = Date.now();
  const moved = status !== before.status;
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.tasks,
      Key: { taskId: before.taskId },
      UpdateExpression: `SET ai = :ai, updatedAt = :now, #status = :status${
        moved ? ", doneAt = :doneAt, isArchived = :no" : ""
      }`,
      ConditionExpression: "attribute_exists(taskId)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":ai": ai,
        ":now": now,
        ":status": status,
        ...(moved && { ":doneAt": status === "DONE" ? now : null, ":no": false }),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  const task = toTask(Attributes ?? {});
  await notifyBoard(board, {
    type: "board.task_updated",
    boardId: board.boardId,
    task,
    by,
    boardName: board.name,
    ...(moved && { previousStatus: before.status }),
  });
  return task;
}

/**
 * `POST /tasks/{taskId}/ai` ("Hacer con IA"): admins only, since what it
 * writes goes to production. Marks the task as queued and starts the
 * `ai-task` workflow on GitHub, which does the work and reports back.
 */
async function startTaskAi(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  if (caller.role !== "admin") throw forbidden("Only admins can hand a task to the AI");
  const taskId = pathParam(event, "taskId");
  const { task, board } = await accessibleTask(taskId, caller);
  if (task.status === "DONE") throw new HttpError(409, "This task is already done");
  if (taskAiBusy(task)) throw new HttpError(409, "The AI is already working on this task");
  const token = await githubActionsToken.get();
  const repository = process.env.AI_TASK_REPOSITORY;
  if (!token || !repository) {
    throw new HttpError(
      503,
      "Tasks by AI aren't set up yet: the GitHub token (github-actions-token) is missing.",
    );
  }
  const queued = await setTaskAi(
    board,
    task,
    { phase: "queued", requestedBy: caller.userId, requestedAt: Date.now() },
    task.status,
    caller.userId,
  );
  try {
    const response = await aiFetch(
      `https://api.github.com/repos/${repository}/actions/workflows/ai-task.yml/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "MindfulTechSlack",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            task_id: task.taskId,
            title: task.title.slice(0, 300),
            // What to build: the task's description and notes, as its author wrote them.
            details: [task.description, task.notes].filter(Boolean).join("\n\n").slice(0, 6_000),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  } catch (err) {
    log.error("ai task: couldn't start the workflow", { taskId, ...errorFields(err) });
    await setTaskAi(
      board,
      queued,
      {
        ...queued.ai!,
        phase: "failed",
        summary: "No se pudo iniciar el trabajo en GitHub. Revisa el token y vuelve a intentarlo.",
        finishedAt: Date.now(),
      },
      queued.status,
      caller.userId,
    );
    throw new HttpError(502, "Couldn't start the AI's run on GitHub");
  }
  log.info("ai task queued", { taskId, userId: caller.userId });
  return json(202, { task: queued });
}

/** Who moved the task, for the board's live update, when it was the workflow. */
const AI_TASK_AUTHOR = "ai";

/** The column each phase puts the task in. */
const AI_PHASE_STATUS: Record<TaskAiUpdate["phase"], TaskStatus | null> = {
  running: "IN_PROGRESS",
  deploying: "IN_PROGRESS",
  done: "DONE",
  // Back where a person can pick it up or retry.
  failed: "TODO",
};

/**
 * The workflow reporting its progress. Not an HTTP route: the run invokes this
 * Lambda directly with its AWS role, so there's no public endpoint or shared
 * secret to guard. Only a task the AI was asked to do can be moved this way.
 */
export async function applyTaskAiUpdate(update: TaskAiUpdate): Promise<void> {
  if (!TASK_AI_PHASES.includes(update.phase) || typeof update.taskId !== "string") return;
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.tasks, Key: { taskId: update.taskId } }),
  );
  if (!Item) return;
  const task = toTask(Item);
  if (!task.ai) {
    log.warn("ai task update for a task the AI wasn't asked to do", { taskId: task.taskId });
    return;
  }
  const board = await getLiveBoard(task.boardId);
  if (!board) return;
  const finished = update.phase === "done" || update.phase === "failed";
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  const runUrl = text(update.runUrl, 300);
  const commit = text(update.commit, 64);
  const summary = text(update.summary, TASK_AI_SUMMARY_MAX);
  await setTaskAi(
    board,
    task,
    {
      ...task.ai,
      phase: update.phase,
      ...(runUrl?.startsWith("https://github.com/") && { runUrl }),
      ...(commit && { commit }),
      ...(summary && { summary }),
      ...(finished && { finishedAt: Date.now() }),
    },
    AI_PHASE_STATUS[update.phase] ?? task.status,
    AI_TASK_AUTHOR,
  );
  log.info("ai task update", { taskId: task.taskId, phase: update.phase });
}

// --- Router ----------------------------------------------------------------------

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /boards": (_e, c) => listBoards(c),
  "POST /boards": createBoard,
  "PUT /boards/{id}": renameBoard,
  "DELETE /boards/{id}": deleteBoard,
  "POST /boards/{id}/members": addMembers,
  "POST /boards/{id}/invites": inviteToBoard,
  "POST /channels/{channelId}/invites": inviteToChannel,
  "GET /boards/{id}/tasks": listTasks,
  "POST /boards/{id}/tasks": createTask,
  "POST /boards/{id}/tasks/from-notes": createTasksFromNotes,
  "PUT /tasks/{taskId}": updateTask,
  "DELETE /tasks/{taskId}": deleteTask,
  "POST /tasks/{taskId}/ai": startTaskAi,
};

const http = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});

/** HTTP requests, and (Phase 65) the AI workflow's direct `{ aiTask }` invocations. */
export const handler = async (event: HttpEvent | { aiTask: TaskAiUpdate }) => {
  if ("aiTask" in event) return applyTaskAiUpdate(event.aiTask);
  return http(event);
};
