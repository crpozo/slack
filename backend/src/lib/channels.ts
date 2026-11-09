import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { canSeeChannel, type Channel, type Role } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";

/**
 * Who is asking for a channel: their id and role. The role is required so no
 * caller can forget it: an external (guest) sees only the private channels
 * they were invited to (`canSeeChannel`), never a public one.
 */
export interface ChannelViewer {
  userId: string;
  role: Role;
}

/**
 * Loads a channel the caller may use: it must exist, be one they may see
 * (`canSeeChannel`: public or listing them among its members; for a guest,
 * private and listing them), and (unless `allowArchived`: reading history,
 * downloading a file) not be archived. Anything else returns `null`, which
 * handlers report as CHANNEL_NOT_FOUND so private channels stay hidden.
 */
export async function getAccessibleChannel(
  channelId: string,
  viewer: ChannelViewer,
  { allowArchived = false }: { allowArchived?: boolean } = {},
): Promise<Channel | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.channels, Key: { channelId } }),
  );
  const channel = Item as Channel | undefined;
  if (!channel || !canSeeChannel(channel, viewer.userId, viewer.role)) return null;
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

/**
 * Broadcast filter: who may receive events of `channel`. By role: a guest's
 * connection only for the private channels they're in. A connection row
 * without a role predates roles: a member, as everywhere else.
 */
export function channelAudience(channel: Pick<Channel, "type" | "members">) {
  return (connection: { userId: string; role?: Role }) =>
    canSeeChannel(channel, connection.userId, connection.role ?? "member");
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

/** All channels (< 50 at this scale, so a Scan is fine), oldest first. */
export async function scanChannels(): Promise<Channel[]> {
  const channels: Channel[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.channels })) {
    channels.push(...((page.Items ?? []) as Channel[]));
  }
  return channels.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Public channels plus the private channels and DMs `userId` belongs to; a
 * guest only the private channels they're in (`canSeeChannel`).
 * Archived channels are listed too (the client shows them under "Archived",
 * read-only); posting to them is refused by `getAccessibleChannel`.
 */
export function visibleTo(channels: Channel[], userId: string, role: Role | undefined): Channel[] {
  return channels.filter((c) => canSeeChannel(c, userId, role ?? "member"));
}
