import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { deliver, listConnections } from "../lib/broadcast";
import { vacate } from "../lib/callRooms";
import { getAccessibleChannel } from "../lib/channels";
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
async function leaveCall(channelId: string, userId: string, connectionId: string): Promise<void> {
  try {
    const channel = await getAccessibleChannel(channelId, userId, { allowArchived: true });
    if (channel) await vacate(channel, userId, connectionId);
  } catch (err) {
    log.error("couldn't free a call seat", { channelId, connectionId, ...errorFields(err) });
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
    if (userId && callRoom) await leaveCall(callRoom, userId, connectionId);
    if (userId) await announceIfLast(userId);
  } catch (err) {
    log.error("disconnect failed", { connectionId, ...errorFields(err) });
  }
  return ok();
};
