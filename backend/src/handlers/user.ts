import { GetCommand, paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_PINNED_CHATS,
  parseAction,
  UserActionSchema,
  type UserAction,
  type UserProfile,
} from "@mindfultech/shared";
import { boardsOf } from "../lib/boards";
import { broadcast, deliver, listConnections, onlineUserIds } from "../lib/broadcast";
import { getAccessibleChannel } from "../lib/channels";
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

/** The caller's pinned conversations, most recent pin first. */
async function pinnedOf(userId: string): Promise<string[]> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.users, Key: { userId }, ProjectionExpression: "pinned" }),
  );
  const pinned: unknown = Item?.pinned;
  return Array.isArray(pinned) ? pinned.map(String) : [];
}

/**
 * The directory as `caller` may see it. Members see everyone. A guest sees
 * only the people on their boards (for assignees and names), and no presence.
 */
async function listUsers(caller: Caller) {
  if (caller.role === "guest") {
    const [users, boards] = await Promise.all([scanUsers(), boardsOf(caller.userId)]);
    const visible = new Set(boards.flatMap((b) => [b.ownerId, ...b.members]));
    visible.add(caller.userId);
    const list = users.filter((u) => visible.has(u.userId));
    await reply(caller.connectionId, { type: "user.list", users: list });
    return ok();
  }
  const [users, online, pinned] = await Promise.all([
    scanUsers(),
    onlineUserIds(),
    pinnedOf(caller.userId),
  ]);
  await reply(caller.connectionId, { type: "user.list", users, online });
  await reply(caller.connectionId, { type: "user.prefs", pinned });
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
  if (action.pinned && !(await getAccessibleChannel(action.channelId, caller.userId))) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  const current = await pinnedOf(caller.userId);
  const rest = current.filter((id) => id !== action.channelId);
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
  const mine = (await listConnections()).filter((c) => c.userId === caller.userId);
  await deliver(mine, () => ({ type: "user.prefs", pinned }));
  return ok();
}

/** `user`: list the directory, update your own display name, or pin a conversation. */
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
  }
});
