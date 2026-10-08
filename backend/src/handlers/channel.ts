import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ChannelActionSchema,
  dmChannelId,
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

/** Non-archived public channels plus the DMs `userId` takes part in. */
export function visibleTo(channels: Channel[], userId: string): Channel[] {
  return channels.filter(
    (c) => !c.archived && (c.type === "public" || (c.members ?? []).includes(userId)),
  );
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

/** `channel`: list, create a public channel, or open a DM. */
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
      if (existing.some((c) => c.type === "public" && c.name === action.name)) {
        return replyError(caller.connectionId, "CHANNEL_NAME_TAKEN");
      }
      const channel: Channel = {
        channelId: newChannelId(),
        name: action.name,
        type: "public",
        createdBy: caller.userId,
        createdAt: Date.now(),
        archived: false,
      };
      await putIfAbsent(channel);
      log.info("channel created", { channelId: channel.channelId, userId: caller.userId });
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
  }
});
