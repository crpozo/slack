import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { isChannelMember, type Channel } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

/**
 * Loads a channel the caller may use: it must exist, be public or list the
 * caller among its members, and (unless `allowArchived`: reading history,
 * downloading a file) not be archived. Anything else returns `null`, which
 * handlers report as CHANNEL_NOT_FOUND so private channels stay hidden.
 */
export async function getAccessibleChannel(
  channelId: string,
  userId: string,
  { allowArchived = false }: { allowArchived?: boolean } = {},
): Promise<Channel | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.channels, Key: { channelId } }),
  );
  const channel = Item as Channel | undefined;
  if (!channel || !isChannelMember(channel, userId)) return null;
  if (channel.archived && !allowArchived) return null;
  return channel;
}

/** The other member of a DM (the sender themself for a self-DM), or `null`. */
export function dmPeerOf(
  channel: Pick<Channel, "type" | "members">,
  userId: string,
): string | null {
  if (channel.type !== "dm") return null;
  const members = channel.members ?? [];
  return members.find((m) => m !== userId) ?? (members.includes(userId) ? userId : null);
}

/** Broadcast filter: who may receive events of `channel`. */
export function channelAudience(channel: Pick<Channel, "type" | "members">) {
  return (connection: { userId: string }) => isChannelMember(channel, connection.userId);
}
