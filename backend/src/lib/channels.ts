import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isChannelMember, type Channel } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";

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

/**
 * Records that something was written in `channelId` at `at` (`lastMessageAt`,
 * which orders the sidebar). Monotonic: an older timestamp never wins, so two
 * Lambdas racing can't move it backwards. Best effort: a failure is logged,
 * the message was already stored and the clients bump their own copy.
 */
export async function touchChannel(channelId: string, at: number): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.channels,
        Key: { channelId },
        UpdateExpression: "SET lastMessageAt = :at",
        ConditionExpression:
          "attribute_exists(channelId) AND (attribute_not_exists(lastMessageAt) OR lastMessageAt < :at)",
        ExpressionAttributeValues: { ":at": at },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return; // newer already, or gone
    log.warn("couldn't record channel activity", { channelId, ...errorFields(err) });
  }
}
