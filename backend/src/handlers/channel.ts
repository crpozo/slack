import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  GetCommand,
  paginateScan,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ChannelActionSchema,
  dmChannelId,
  isChannelMember,
  newChannelId,
  parseAction,
  type Channel,
} from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";

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

/** Ids among `userIds` that have no row in `users` (never signed in). */
async function unknownUsers(userIds: string[]): Promise<string[]> {
  const found = new Set<string>();
  let keys: Record<string, unknown>[] | undefined = userIds.map((userId) => ({ userId }));
  // BatchGet may return UnprocessedKeys under throttling: retry those once.
  for (let attempt = 0; attempt < 2 && keys?.length; attempt++) {
    const result: BatchGetCommandOutput = await ddb.send(
      new BatchGetCommand({
        RequestItems: { [tables.users]: { Keys: keys, ProjectionExpression: "userId" } },
      }),
    );
    for (const item of result.Responses?.[tables.users] ?? []) found.add(String(item.userId));
    keys = result.UnprocessedKeys?.[tables.users]?.Keys;
  }
  return userIds.filter((id) => !found.has(id));
}

/** `channel`: list, create (private by default), open a DM, or invite to a private channel. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(ChannelActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;

  switch (action.op) {
    case "list": {
      const channels = visibleTo(await scanChannels(), caller.userId);
      await reply(caller.connectionId, { type: "channel.list", channels });
      return ok();
    }

    case "create": {
      const existing = await scanChannels();
      if (existing.some((c) => c.type !== "dm" && c.name === action.name)) {
        return replyError(caller.connectionId, "CHANNEL_NAME_TAKEN");
      }
      const channel: Channel = {
        channelId: newChannelId(),
        name: action.name,
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

    case "dm": {
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
        members: [caller.userId, action.withUserId].sort(),
      });
      if (created) log.info("dm created", { channelId, userId: caller.userId });
      await broadcastChannelList();
      return ok();
    }

    case "invite": {
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

      const members = [...new Set([...(channel.members ?? []), ...invitees])].sort();
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
  }
});
