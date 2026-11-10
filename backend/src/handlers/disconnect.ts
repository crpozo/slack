import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { isRole } from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import { announceRoom, toRoom, vacate, withdrawKnock } from "../lib/callRooms";
import { getAccessibleChannel, getChannelRow, type ChannelViewer } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import type { WsEvent } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { ok, type HandlerResult } from "../lib/response";

/**
 * Presence: if `userId` has no other live connection (tabs, devices), tells
 * everyone they went offline. Consistent read, so the row just deleted is gone.
 */
async function announceIfLast(userId: string): Promise<void> {
  const connections = await listConnections(true);
  if (connections.some((c) => c.userId === userId)) return;
  await deliver(connections, () => ({ type: "user.disconnected", userId }));
  log.info("user offline", { userId });
}

/**
 * Phase 36: the closed socket held a seat in a channel's call: free it, so
 * the others see them leave (and the last one out ends the call).
 */
async function leaveCall(
  viewer: ChannelViewer,
  channelId: string,
  connectionId: string,
): Promise<void> {
  const { userId } = viewer;
  try {
    const channel = await getAccessibleChannel(channelId, viewer, { allowArchived: true });
    if (channel) await vacate(channel, userId, connectionId);
  } catch (err) {
    log.error("couldn't free a call seat", { channelId, connectionId, ...errorFields(err) });
  }
}

/**
 * Phase 59: an external's socket closed: their seat in the call is freed, or
 * they leave its lobby. Nobody is told they went offline (presence is the team's).
 */
async function leaveAsExternal(
  userId: string,
  channelId: string,
  seated: boolean,
  connectionId: string,
): Promise<void> {
  try {
    const channel = await getChannelRow(channelId);
    if (!channel) return;
    if (seated) await vacate(channel, userId, connectionId);
    const room = await withdrawKnock(channelId, userId, connectionId);
    if (room) {
      await announceRoom(channel, {
        type: "call.room",
        channelId,
        room: toRoom(room),
        change: "waiting",
        userId,
      });
    }
  } catch (err) {
    log.error("couldn't take an external out of a call", {
      channelId,
      connectionId,
      ...errorFields(err),
    });
  }
}

/**
 * `$disconnect`: best effort — the TTL cleans up anything left behind.
 * API Gateway forwards the `$connect` authorizer context here too.
 */
export const handler = async (event: WsEvent): Promise<HandlerResult> => {
  const { connectionId, authorizer } = event.requestContext;
  try {
    const { Attributes } = await ddb.send(
      new DeleteCommand({
        TableName: tables.connections,
        Key: { connectionId },
        ReturnValues: "ALL_OLD",
      }),
    );
    log.info("disconnected", { connectionId });
    const userId = authorizer?.userId ?? (Attributes?.userId as string | undefined);
    const callRoom = Attributes?.callRoom as string | undefined;
    const callScope =
      authorizer?.external === "1"
        ? authorizer.callScope
        : Attributes?.external
          ? (Attributes.callScope as string | undefined)
          : undefined;
    if (callScope) {
      if (userId) await leaveAsExternal(userId, callScope, callRoom === callScope, connectionId);
      return ok();
    }
    const role = isRole(authorizer?.role)
      ? authorizer.role
      : isRole(Attributes?.role)
        ? Attributes.role
        : "member";
    if (userId && callRoom) await leaveCall({ userId, role }, callRoom, connectionId);
    if (userId) await announceIfLast(userId);
  } catch (err) {
    log.error("disconnect failed", { connectionId, ...errorFields(err) });
  }
  return ok();
};
