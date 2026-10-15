import { DeleteCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import { ACTIVE_WINDOW_MS, guestMayReceive, type ServerEvent } from "@mindfultech/shared";
import { ddb, tables, type ConnectionItem } from "./ddb";
import { log } from "./logger";
import { reply } from "./response";

export type LiveConnection = Pick<ConnectionItem, "connectionId" | "userId" | "activeAt" | "role">;

/**
 * All rows of `connections` (≤ a handful at this scale, so a Scan is fine).
 * `consistent` reads see writes made just before (presence checks need that).
 */
export async function listConnections(consistent = false): Promise<LiveConnection[]> {
  const result: LiveConnection[] = [];
  const pages = paginateScan(
    { client: ddb },
    {
      TableName: tables.connections,
      ProjectionExpression: "connectionId, userId, activeAt, #role",
      ExpressionAttributeNames: { "#role": "role" },
      ...(consistent && { ConsistentRead: true }),
    },
  );
  for await (const page of pages) {
    result.push(...((page.Items ?? []) as LiveConnection[]));
  }
  return result;
}

/**
 * Sends each of `connections` the event built for it by `eventFor` (return
 * `null` to skip one). Connections that answer 410 Gone are deleted from
 * `connections`.
 * @returns how many connections the event reached.
 */
export async function deliver(
  connections: LiveConnection[],
  eventFor: (connection: LiveConnection) => ServerEvent | null,
): Promise<number> {
  const results = await Promise.allSettled(
    connections.map(async (connection) => {
      const event = eventFor(connection);
      if (!event) return false;
      // The one choke point for guests: whatever a handler meant to send, a
      // guest's connection only ever gets their boards' events.
      if (connection.role === "guest" && !guestMayReceive(event.type)) return false;
      const delivered = await reply(connection.connectionId, event);
      if (!delivered) {
        await ddb.send(
          new DeleteCommand({
            TableName: tables.connections,
            Key: { connectionId: connection.connectionId },
          }),
        );
        log.info("removed stale connection", { connectionId: connection.connectionId });
      }
      return delivered;
    }),
  );
  let count = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("delivery failed", { reason: String(result.reason) });
    } else if (result.value) {
      count++;
    }
  }
  return count;
}

/** Ids of users with at least one live connection. */
export async function onlineUserIds(): Promise<string[]> {
  return [...new Set((await listConnections()).map((c) => c.userId))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Sends an event to every live connection (see `deliver`). */
export async function broadcast(
  eventFor: (connection: LiveConnection) => ServerEvent | null,
): Promise<void> {
  await deliver(await listConnections(), eventFor);
}

/**
 * People in front of the app right now: some connection of theirs reported
 * `active` within `ACTIVE_WINDOW_MS`. They see events in the app; everyone
 * else (offline, or only connected in the background) gets a Web Push.
 */
export function activeUserIds(connections: LiveConnection[], now = Date.now()): Set<string> {
  return new Set(
    connections
      .filter((c) => c.activeAt !== undefined && now - c.activeAt < ACTIVE_WINDOW_MS)
      .map((c) => c.userId),
  );
}
