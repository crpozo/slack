import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  paginateQuery,
  paginateScan,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  canDeleteChannel,
  ChannelActionSchema,
  channelSlug,
  compareIds,
  dmChannelId,
  GENERAL_CHANNEL_ID,
  isChannelMember,
  isLegacyChannel,
  newChannelId,
  parseAction,
  slugifyChannelName,
  type Channel,
  type ChannelAction,
} from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { channelAudience } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler, type Caller } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { unknownUsers } from "../lib/users";

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

async function listChannels(caller: Caller) {
  const channels = visibleTo(await scanChannels(), caller.userId);
  await reply(caller.connectionId, { type: "channel.list", channels });
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

/** DynamoDB caps BatchWriteItem at 25 requests. */
const BATCH_SIZE = 25;

type WriteRequest = Record<string, unknown>;

/** One BatchWriteItem, re-sending what DynamoDB left unprocessed (throttling) up to `retries` times. */
async function writeBatch(requests: WriteRequest[], retries = 2): Promise<void> {
  const { UnprocessedItems } = await ddb.send(
    new BatchWriteCommand({ RequestItems: { [tables.messages]: requests } }),
  );
  const left = (UnprocessedItems?.[tables.messages] ?? []) as WriteRequest[];
  if (left.length === 0) return;
  if (retries <= 0) throw new Error(`Couldn't delete ${left.length} messages`);
  return writeBatch(left, retries - 1);
}

/** Deletes every message of `channelId`; batches of 25 run concurrently. */
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
  const batches: WriteRequest[][] = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    batches.push(keys.slice(i, i + BATCH_SIZE).map((Key) => ({ DeleteRequest: { Key } })));
  }
  await Promise.all(batches.map((batch) => writeBatch(batch)));
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

/** `channel`: list, create (private by default), open a DM, invite to a private channel, or delete. */
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
  }
});
