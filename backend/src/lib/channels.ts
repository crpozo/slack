import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { isChannelMember, type Channel } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

/**
 * Loads a channel the caller may use: it must exist, not be archived, and be
 * public or list the caller among its members. Anything else returns `null`,
 * which handlers report as CHANNEL_NOT_FOUND so private channels stay hidden.
 */
export async function getAccessibleChannel(
  channelId: string,
  userId: string,
): Promise<Channel | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.channels, Key: { channelId } }),
  );
  const channel = Item as Channel | undefined;
  if (!channel || channel.archived || !isChannelMember(channel, userId)) return null;
  return channel;
}

/** Broadcast filter: who may receive events of `channel`. */
export function channelAudience(channel: Pick<Channel, "type" | "members">) {
  return (connection: { userId: string }) => isChannelMember(channel, connection.userId);
}
