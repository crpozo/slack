import { GetCommand, paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_ORDERED_CHANNELS,
  MAX_PINNED_CHATS,
  parseAction,
  UserActionSchema,
  type UserAction,
  type UserProfile,
} from "@mindfultech/shared";
import { boardsOf } from "../lib/boards";
import { broadcast, deliver, listConnections, onlineUserIds } from "../lib/broadcast";
import { getAccessibleChannel, scanChannels, visibleTo } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler, type Caller } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { toUserProfile } from "../lib/users";

/** Everyone who has signed in at least once (a handful of rows: a Scan is fine). */
async function scanUsers(): Promise<UserProfile[]> {
  const users: UserProfile[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.users })) {
    users.push(...(page.Items ?? []).map(toUserProfile));
  }
  return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The caller's own sidebar preferences: pinned conversations (most recent first) and channel order. */
async function prefsOf(userId: string): Promise<{ pinned: string[]; channelOrder: string[] }> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.users,
      Key: { userId },
      ProjectionExpression: "pinned, channelOrder",
    }),
  );
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  return { pinned: list(Item?.pinned), channelOrder: list(Item?.channelOrder) };
}

/** Sends the caller's preferences to all their open tabs and devices. */
async function deliverPrefs(userId: string, prefs: { pinned: string[]; channelOrder: string[] }) {
  const mine = (await listConnections()).filter((c) => c.userId === userId);
  await deliver(mine, () => ({ type: "user.prefs", ...prefs }));
}

/**
 * The directory as `caller` may see it. Members see everyone. A guest sees
 * only the people on their boards (for assignees and names) and, since
 * Phase 55, in their channels (authors, mentions), and no presence.
 */
async function listUsers(caller: Caller) {
  if (caller.role === "guest") {
    const [users, boards, channels] = await Promise.all([
      scanUsers(),
      boardsOf(caller.userId),
      scanChannels(),
    ]);
    const visible = new Set(boards.flatMap((b) => [b.ownerId, ...b.members]));
    for (const channel of visibleTo(channels, caller.userId, caller.role)) {
      for (const id of channel.members ?? []) visible.add(id);
    }
    visible.add(caller.userId);
    const list = users.filter((u) => visible.has(u.userId));
    await reply(caller.connectionId, { type: "user.list", users: list });
    return ok();
  }
  const [users, online, prefs] = await Promise.all([
    scanUsers(),
    onlineUserIds(),
    prefsOf(caller.userId),
  ]);
  await reply(caller.connectionId, { type: "user.list", users, online });
  await reply(caller.connectionId, { type: "user.prefs", ...prefs });
  return ok();
}

async function updateName(action: Extract<UserAction, { op: "update" }>, caller: Caller) {
  // Only ever the caller's own row: the key comes from the authorizer, not the payload.
  const now = Date.now();
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId: caller.userId },
      UpdateExpression:
        "SET displayName = :name, email = :email, updatedAt = :now, " +
        "createdAt = if_not_exists(createdAt, :now)",
      ExpressionAttributeValues: {
        ":name": action.displayName,
        ":email": caller.userEmail,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  const user = toUserProfile(Attributes ?? { userId: caller.userId });
  log.info("display name updated", { userId: caller.userId });
  await broadcast(() => ({ type: "user.updated", user }));
  return ok();
}

/**
 * Pins or unpins a conversation for the caller only (stored on their `users`
 * row, so it follows them across devices). Their open tabs get `user.prefs`.
 */
async function pin(action: Extract<UserAction, { op: "pin" }>, caller: Caller) {
  if (caller.role === "guest") return replyError(caller.connectionId, "FORBIDDEN");
  if (action.pinned && !(await getAccessibleChannel(action.channelId, caller))) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  const prefs = await prefsOf(caller.userId);
  const rest = prefs.pinned.filter((id) => id !== action.channelId);
  const pinned = action.pinned ? [action.channelId, ...rest].slice(0, MAX_PINNED_CHATS) : rest;
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId: caller.userId },
      UpdateExpression: "SET pinned = :pinned",
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeValues: { ":pinned": pinned },
    }),
  );
  log.info(action.pinned ? "chat pinned" : "chat unpinned", { userId: caller.userId });
  await deliverPrefs(caller.userId, { ...prefs, pinned });
  return ok();
}

/**
 * Saves the caller's own channel order (Phase 53), top to bottom, on their
 * `users` row: it follows them across devices. Ids only (duplicates dropped);
 * the sidebar shows just the channels they can see, so nothing leaks.
 */
async function order(action: Extract<UserAction, { op: "order" }>, caller: Caller) {
  if (caller.role === "guest") return replyError(caller.connectionId, "FORBIDDEN");
  const channelOrder = [...new Set(action.channelOrder)].slice(0, MAX_ORDERED_CHANNELS);
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId: caller.userId },
      UpdateExpression: "SET channelOrder = :order",
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeValues: { ":order": channelOrder },
    }),
  );
  log.info("channel order saved", { userId: caller.userId, count: channelOrder.length });
  const { pinned } = await prefsOf(caller.userId);
  await deliverPrefs(caller.userId, { pinned, channelOrder });
  return ok();
}

/** `user`: list the directory, update your own display name, pin a conversation, or order your channels. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(UserActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;
  switch (action.op) {
    case "list":
      return listUsers(caller);
    case "update":
      return updateName(action, caller);
    case "pin":
      return pin(action, caller);
    case "order":
      return order(action, caller);
  }
});
