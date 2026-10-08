import { DeleteCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import type { ServerEvent } from "@mindfultech/shared";
import { ddb, tables, type ConnectionItem } from "./ddb";
import { log } from "./logger";
import { reply } from "./response";

type LiveConnection = Pick<ConnectionItem, "connectionId" | "userId">;

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
 * Sends an event to every live connection, built per recipient by `eventFor`
 * (return `null` to skip that recipient). Connections that answer 410 Gone
 * are deleted from `connections`.
 */
export async function broadcast(
  eventFor: (connection: LiveConnection) => ServerEvent | null,
): Promise<void> {
  const connections = await listConnections();
  const results = await Promise.allSettled(
    connections.map(async (connection) => {
      const event = eventFor(connection);
      if (!event) return;
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
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("broadcast delivery failed", { reason: String(result.reason) });
    }
  }
}
