import { DeleteCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import type { ServerEvent } from "@mindfultech/shared";
import { ddb, tables, type ConnectionItem } from "./ddb";
import { log } from "./logger";
import { reply } from "./response";

export type LiveConnection = Pick<ConnectionItem, "connectionId" | "userId">;

/** All rows of `connections` (≤ a handful at this scale, so a Scan is fine). */
export async function listConnections(): Promise<LiveConnection[]> {
  const result: LiveConnection[] = [];
  const pages = paginateScan(
    { client: ddb },
    { TableName: tables.connections, ProjectionExpression: "connectionId, userId" },
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

/** Sends an event to every live connection (see `deliver`). */
export async function broadcast(
  eventFor: (connection: LiveConnection) => ServerEvent | null,
): Promise<void> {
  await deliver(await listConnections(), eventFor);
}
