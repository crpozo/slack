import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  paginateQuery,
  paginateScan,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  canDeleteChannel,
  canArchiveChannel,
  canEditChannel,
  canRenameChannel,
  ChannelActionSchema,
  channelSlug,
  compareIds,
  dmChannelId,
  GENERAL_CHANNEL_ID,
  isChannelMember,
  MAX_UNREAD_COUNT,
  isLegacyChannel,
  newChannelId,
  parseAction,
  slugifyChannelName,
  type Board,
  type Channel,
  type ChannelAction,
  type ProjectBoard,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { boardAudience, boardRows, getAccessibleBoard } from "../lib/boards";
import { broadcast, deliver, listConnections } from "../lib/broadcast";
import { channelAudience } from "../lib/channels";
import { batchDelete, ddb, tables } from "../lib/ddb";
import { wsHandler, type Caller } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { guestsAmong, unknownUsers } from "../lib/users";

/** All channels (< 50 at this scale, so a Scan is fine), oldest first. */
async function scanChannels(): Promise<Channel[]> {
  const channels: Channel[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.channels })) {
    channels.push(...((page.Items ?? []) as Channel[]));
  }
  return channels.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Public channels plus the private channels and DMs `userId` belongs to.
 * Archived channels are listed too (the client shows them under "Archived",
 * read-only); posting to them is refused by `getAccessibleChannel`.
 */
export function visibleTo(channels: Channel[], userId: string): Channel[] {
  return channels.filter((c) => isChannelMember(c, userId));
}

/** Sends every connection its own filtered `channel.list`. */
async function broadcastChannelList(): Promise<void> {
  const channels = await scanChannels();
  await broadcast((connection) => ({
    type: "channel.list",
    channels: visibleTo(channels, connection.userId),
  }));
}

/** Creates an item unless its key exists; returns `false` if it already existed. */
async function putIfAbsent(item: Channel): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.channels,
        Item: item,
        ConditionExpression: "attribute_not_exists(channelId)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

type ActionOf<Op extends ChannelAction["op"]> = Extract<ChannelAction, { op: Op }>;

/** Without a read mark, only the last week counts as unread (not a channel's whole history). */
export const UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Messages from others after `userId`'s read mark in `channel`, newest first,
 * stopping at their own latest message (writing in a conversation means you
 * read it) and at `MAX_UNREAD_COUNT + 1`. One small Query per channel.
 */
export async function unreadCount(channel: Channel, userId: string): Promise<number> {
  const after = channel.reads?.[userId]?.sk ?? `${Date.now() - UNREAD_LOOKBACK_MS}`;
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: tables.messages,
      KeyConditionExpression: "channelId = :c AND sk > :after",
      ExpressionAttributeValues: { ":c": channel.channelId, ":after": after },
      ProjectionExpression: "userId",
      ScanIndexForward: false,
      Limit: MAX_UNREAD_COUNT + 1,
    }),
  );
  const mine = Items.findIndex((m) => m.userId === userId);
  return mine === -1 ? Items.length : mine;
}

async function listChannels(caller: Caller) {
  const channels = visibleTo(await scanChannels(), caller.userId);
  const counts = await Promise.all(
    channels.map((c) =>
      unreadCount(c, caller.userId).catch((err: unknown) => {
        log.warn("unread count failed", { channelId: c.channelId, ...errorFields(err) });
        return 0;
      }),
    ),
  );
  const unread: Record<string, number> = {};
  channels.forEach((c, i) => {
    if (counts[i]) unread[c.channelId] = counts[i]!;
  });
  await reply(caller.connectionId, { type: "channel.list", channels, unread });
  return ok();
}

/** What a project channel's board request resolved to, or why it was refused. */
type ProjectOutcome =
  | { ok: true; linkedBoardId?: string; newBoard?: Board }
  | { ok: false; code: "BOARD_NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST"; message: string };

/**
 * Resolves the board of a project channel: `link` must be a board the caller
 * can see; `create` builds a board named after the channel with the caller
 * as owner and the channel's members (private channels) on it. The rows are
 * written by the caller in the same transaction as the channel.
 */
async function resolveProjectBoard(
  board: ProjectBoard | undefined,
  caller: Caller,
  channel: Pick<Channel, "name" | "members">,
  current?: string,
): Promise<ProjectOutcome> {
  if (!board) {
    if (current) return { ok: true, linkedBoardId: current }; // already has one
    return { ok: false, code: "BAD_REQUEST", message: "A project needs a board" };
  }
  if (board.mode === "link") {
    const linked = await getAccessibleBoard(board.boardId, caller.userId);
    if (!linked) {
      return { ok: false, code: "BOARD_NOT_FOUND", message: "That board doesn't exist" };
    }
    return { ok: true, linkedBoardId: linked.boardId };
  }
  if (caller.role === "guest") {
    return { ok: false, code: "FORBIDDEN", message: "Guests can't create boards" };
  }
  const members = [...new Set([caller.userId, ...(channel.members ?? [])])].sort(compareIds);
  const newBoard: Board = {
    boardId: `b_${ulid()}`,
    name: channel.name,
    ownerId: caller.userId,
    members,
    createdAt: Date.now(),
  };
  return { ok: true, linkedBoardId: newBoard.boardId, newBoard };
}

/** The new board shows up in its members' Task Manager at once (as `addMembers` does). */
async function announceBoard(board: Board): Promise<void> {
  try {
    const connections = await listConnections();
    await deliver(connections.filter(boardAudience(board)), () => ({
      type: "board.updated",
      board,
    }));
  } catch (err) {
    log.error("board announce failed", { boardId: board.boardId, ...errorFields(err) });
  }
}

async function createChannel(action: ActionOf<"create">, caller: Caller) {
  // The readable name is kept as typed ("Web Design"); uniqueness is on its slug.
  const slug = slugifyChannelName(action.name);
  const existing = await scanChannels();
  if (existing.some((c) => c.type !== "dm" && channelSlug(c) === slug)) {
    return replyError(caller.connectionId, "CHANNEL_NAME_TAKEN");
  }
  const channel: Channel = {
    channelId: newChannelId(),
    name: action.name,
    slug,
    type: action.visibility,
    createdBy: caller.userId,
    createdAt: Date.now(),
    archived: false,
    ...(action.visibility === "private" && { members: [caller.userId] }),
  };
  let newBoard: Board | undefined;
  if (action.isProject) {
    const project = await resolveProjectBoard(action.board, caller, channel);
    if (!project.ok) return replyError(caller.connectionId, project.code, project.message);
    channel.isProject = true;
    channel.linkedBoardId = project.linkedBoardId;
    newBoard = project.newBoard;
  }
  if (newBoard) {
    // Channel and board in one transaction: neither exists without the other.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.channels,
              Item: channel,
              ConditionExpression: "attribute_not_exists(channelId)",
            },
          },
          ...boardRows(newBoard),
        ],
      }),
    );
  } else {
    await putIfAbsent(channel);
  }
  log.info("channel created", {
    channelId: channel.channelId,
    type: channel.type,
    userId: caller.userId,
    ...(channel.isProject && { boardId: channel.linkedBoardId, newBoard: !!newBoard }),
  });
  if (newBoard) await announceBoard(newBoard);
  await broadcastChannelList();
  return ok();
}

async function openDm(action: ActionOf<"dm">, caller: Caller) {
  // DM ids are `dm_<a>_<b>`, so user ids must not contain `_`.
  if (action.withUserId.includes("_")) {
    return badRequest(caller.connectionId, "Invalid user id");
  }
  if ((await guestsAmong([action.withUserId])).length > 0) {
    return replyError(caller.connectionId, "FORBIDDEN", "Guests only have access to their boards");
  }
  const channelId = dmChannelId(caller.userId, action.withUserId);
  const created = await putIfAbsent({
    channelId,
    name: channelId,
    type: "dm",
    createdBy: caller.userId,
    createdAt: Date.now(),
    archived: false,
    members: [caller.userId, action.withUserId].sort(compareIds),
  });
  if (created) log.info("dm created", { channelId, userId: caller.userId });
  await broadcastChannelList();
  return ok();
}

async function invite(action: ActionOf<"invite">, caller: Caller) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.channels, Key: { channelId: action.channelId } }),
  );
  const channel = Item as Channel | undefined;
  // Non-members can't tell a private channel exists.
  if (!channel || channel.archived || !isChannelMember(channel, caller.userId)) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  if (channel.type !== "private") {
    return badRequest(caller.connectionId, "Only private channels take invitations");
  }
  if (channel.createdBy !== caller.userId) {
    return replyError(caller.connectionId, "FORBIDDEN", "Only the channel creator can invite");
  }

  const invitees = [...new Set(action.userIds)];
  const missing = await unknownUsers(invitees);
  if (missing.length > 0) {
    return replyError(
      caller.connectionId,
      "USER_NOT_FOUND",
      `Unknown users: ${missing.join(", ")}`,
    );
  }

  if ((await guestsAmong(invitees)).length > 0) {
    return replyError(caller.connectionId, "FORBIDDEN", "Guests can't join channels");
  }

  const members = [...new Set([...(channel.members ?? []), ...invitees])].sort(compareIds);
  await ddb.send(
    new UpdateCommand({
      TableName: tables.channels,
      Key: { channelId: channel.channelId },
      UpdateExpression: "SET members = :members",
      ConditionExpression: "createdBy = :me AND #type = :private",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: {
        ":members": members,
        ":me": caller.userId,
        ":private": "private",
      },
    }),
  );
  log.info("members invited", {
    channelId: channel.channelId,
    userId: caller.userId,
    invited: invitees.length,
  });
  await broadcastChannelList();
  return ok();
}

/** Deletes every message of `channelId` (batches of 25, concurrently). */
async function deleteMessages(channelId: string): Promise<number> {
  const keys: Array<{ channelId: string; sk: string }> = [];
  const pages = paginateQuery(
    { client: ddb },
    {
      TableName: tables.messages,
      KeyConditionExpression: "channelId = :c",
      ExpressionAttributeValues: { ":c": channelId },
      ProjectionExpression: "channelId, sk",
    },
  );
  for await (const page of pages) {
    keys.push(...((page.Items ?? []) as typeof keys));
  }
  await batchDelete(tables.messages, keys);
  return keys.length;
}

/** Whether a channel's creator is in the users directory (only looked up when it matters). */
async function creatorKnown(channel: Channel, userId: string): Promise<boolean> {
  const creator = channel.createdBy?.trim();
  if (channel.type === "dm" || !creator || creator === userId || isLegacyChannel(channel)) {
    return true;
  }
  return (await unknownUsers([creator])).length === 0;
}

async function deleteChannel(action: ActionOf<"delete">, caller: Caller) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.channels, Key: { channelId: action.channelId } }),
  );
  const channel = Item as Channel | undefined;
  // Non-members can't tell a private channel exists.
  if (!channel || !isChannelMember(channel, caller.userId)) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  if (channel.channelId === GENERAL_CHANNEL_ID) {
    return replyError(caller.connectionId, "FORBIDDEN", "#general can't be deleted");
  }
  // A DM belongs to both people; a channel to whoever created it — unless it is
  // legacy test data (no slug / no creator) or its creator no longer exists.
  if (!canDeleteChannel(channel, caller.userId, await creatorKnown(channel, caller.userId))) {
    return replyError(caller.connectionId, "FORBIDDEN", "Only the channel creator can delete it");
  }

  // Messages first: if this fails half way the channel is still there to retry.
  const deleted = await deleteMessages(channel.channelId);
  await ddb.send(
    new DeleteCommand({ TableName: tables.channels, Key: { channelId: channel.channelId } }),
  );
  log.info("channel deleted", {
    channelId: channel.channelId,
    type: channel.type,
    userId: caller.userId,
    messages: deleted,
  });
  // Everyone who could see it (computed from the row we just deleted).
  const audience = channelAudience(channel);
  await broadcast((connection) =>
    audience(connection)
      ? { type: "channel.deleted", channelId: channel.channelId, by: caller.userId }
      : null,
  );
  return ok();
}

/**
 * Edits a channel's name, topic and/or description: its creator or an admin,
 * never a DM. Renaming follows `canRenameChannel` (never `#general`); the id
 * and messages stay, only `name` and `slug` change, and the new slug must be
 * free. Everyone who can see the channel gets `channel.updated`.
 */
async function updateChannel(action: ActionOf<"update"> | ActionOf<"rename">, caller: Caller) {
  const channels = await scanChannels();
  const channel = channels.find((c) => c.channelId === action.channelId);
  const archiving = "archived" in action ? action.archived : undefined;
  if (!channel || !isChannelMember(channel, caller.userId)) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  // An archived channel is frozen, except for an admin restoring it.
  if (channel.archived && archiving !== false) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  if (archiving !== undefined) {
    if (channel.type === "dm" || channel.channelId === GENERAL_CHANNEL_ID) {
      return replyError(caller.connectionId, "FORBIDDEN", "This conversation can't be archived");
    }
    // Phase 32: its creator too, not only admins.
    if (!canArchiveChannel(channel, caller.userId, caller.role)) {
      return replyError(
        caller.connectionId,
        "FORBIDDEN",
        "Only the channel creator or an admin can archive it",
      );
    }
  }
  const fields = {
    name: action.name,
    topic: "topic" in action ? action.topic : undefined,
    description: "description" in action ? action.description : undefined,
    isProject: "isProject" in action ? action.isProject : undefined,
    board: "board" in action ? action.board : undefined,
  };
  const renaming = fields.name !== undefined && fields.name !== channel.name;
  const allowed = renaming
    ? canRenameChannel(channel, caller.userId, caller.role)
    : canEditChannel(channel, caller.userId, caller.role);
  if (!allowed) {
    return replyError(
      caller.connectionId,
      "FORBIDDEN",
      renaming
        ? "Only the channel creator or an admin can rename it"
        : "Only the channel creator or an admin can edit it",
    );
  }
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  const assign = (key: string, value: unknown) => {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  };
  const remove = (key: string) => {
    names[`#${key}`] = key;
    removes.push(`#${key}`);
  };
  if (renaming) {
    const slug = slugifyChannelName(fields.name!);
    if (
      channels.some(
        (c) => c.type !== "dm" && c.channelId !== channel.channelId && channelSlug(c) === slug,
      )
    ) {
      return replyError(caller.connectionId, "CHANNEL_NAME_TAKEN");
    }
    assign("name", fields.name);
    assign("slug", slug);
  }
  if (fields.topic !== undefined) assign("topic", fields.topic);
  if (fields.description !== undefined) assign("description", fields.description);
  if (archiving !== undefined && archiving !== !!channel.archived) assign("archived", archiving);

  // Project settings: a board to link or create, or turning the project off.
  let newBoard: Board | undefined;
  let unlinked = false;
  const wantsProject = fields.isProject ?? (fields.board ? true : undefined);
  if (wantsProject === true) {
    const project = await resolveProjectBoard(
      fields.board,
      caller,
      { name: fields.name ?? channel.name, members: channel.members },
      channel.linkedBoardId,
    );
    if (!project.ok) return replyError(caller.connectionId, project.code, project.message);
    newBoard = project.newBoard;
    if (!channel.isProject) assign("isProject", true);
    if (project.linkedBoardId !== channel.linkedBoardId) {
      assign("linkedBoardId", project.linkedBoardId);
    }
  } else if (wantsProject === false && (channel.isProject || channel.linkedBoardId)) {
    assign("isProject", false);
    if (channel.linkedBoardId) remove("linkedBoardId");
    unlinked = true;
  }
  if (sets.length === 0 && removes.length === 0) return ok(); // same name, nothing else

  const expression = [
    sets.length ? `SET ${sets.join(", ")}` : "",
    removes.length ? `REMOVE ${removes.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const update = {
    TableName: tables.channels,
    Key: { channelId: channel.channelId },
    UpdateExpression: expression,
    ConditionExpression: "attribute_exists(channelId)",
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
  };
  let Attributes: Record<string, unknown> | undefined;
  if (newBoard) {
    // The channel's new link and the board itself: one transaction, no half state.
    await ddb.send(
      new TransactWriteCommand({ TransactItems: [{ Update: update }, ...boardRows(newBoard)] }),
    );
  } else {
    ({ Attributes } = await ddb.send(new UpdateCommand({ ...update, ReturnValues: "ALL_NEW" })));
  }
  const patch = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.slice(1), v]),
  ) as Partial<Channel>;
  const merged: Channel = { ...channel, ...patch };
  if (unlinked) delete merged.linkedBoardId;
  const updated = (Attributes ?? merged) as Channel;
  if (newBoard) await announceBoard(newBoard);
  log.info("channel updated", {
    channelId: channel.channelId,
    userId: caller.userId,
    fields: Object.keys(patch),
  });
  const inAudience = channelAudience(updated);
  await broadcast((connection) =>
    inAudience(connection) ? { type: "channel.updated", channel: updated } : null,
  );
  return ok();
}

/** `channel`: list, create (private by default), open a DM, invite to a private channel, edit (rename, topic, description), or delete. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(ChannelActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;

  switch (action.op) {
    case "list":
      return listChannels(caller);
    case "create":
      return createChannel(action, caller);
    case "dm":
      return openDm(action, caller);
    case "invite":
      return invite(action, caller);
    case "delete":
      return deleteChannel(action, caller);
    case "rename":
    case "update":
      return updateChannel(action, caller);
  }
});
