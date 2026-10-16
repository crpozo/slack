import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  paginateQuery,
  paginateScan,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  canDeleteChannel,
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
  type Channel,
  type ChannelAction,
} from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
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

/** Non-archived public channels plus the private channels and DMs `userId` belongs to. */
export function visibleTo(channels: Channel[], userId: string): Channel[] {
  return channels.filter((c) => !c.archived && isChannelMember(c, userId));
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
  await putIfAbsent(channel);
  log.info("channel created", {
    channelId: channel.channelId,
    type: channel.type,
    userId: caller.userId,
  });
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
 * Renames a channel: its creator or an admin, never `#general` or a DM. The id
 * and messages stay; only `name` and `slug` change, and the new slug must be free.
 */
async function renameChannel(action: ActionOf<"rename">, caller: Caller) {
  const channels = await scanChannels();
  const channel = channels.find((c) => c.channelId === action.channelId);
  if (!channel || channel.archived || !isChannelMember(channel, caller.userId)) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }
  if (!canRenameChannel(channel, caller.userId, caller.role)) {
    return replyError(
      caller.connectionId,
      "FORBIDDEN",
      "Only the channel creator or an admin can rename it",
    );
  }
  const slug = slugifyChannelName(action.name);
  if (
    channels.some(
      (c) => c.type !== "dm" && c.channelId !== channel.channelId && channelSlug(c) === slug,
    )
  ) {
    return replyError(caller.connectionId, "CHANNEL_NAME_TAKEN");
  }
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.channels,
      Key: { channelId: channel.channelId },
      UpdateExpression: "SET #name = :name, slug = :slug",
      ConditionExpression: "attribute_exists(channelId)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": action.name, ":slug": slug },
      ReturnValues: "ALL_NEW",
    }),
  );
  const updated = (Attributes ?? { ...channel, name: action.name, slug }) as Channel;
  log.info("channel renamed", { channelId: channel.channelId, userId: caller.userId });
  const inAudience = channelAudience(updated);
  await broadcast((connection) =>
    inAudience(connection) ? { type: "channel.updated", channel: updated } : null,
  );
  return ok();
}

/** `channel`: list, create (private by default), open a DM, invite to a private channel, rename, or delete. */
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
      return renameChannel(action, caller);
  }
});
