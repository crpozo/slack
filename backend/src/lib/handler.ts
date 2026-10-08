import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { ddb, tables, type ConnectionItem } from "./ddb";
import { errorFields, log } from "./logger";
import { replyError, type HandlerResult } from "./response";

/** WebSocket event including the context returned by the `$connect` authorizer. */
export type WsEvent = APIGatewayProxyWebsocketEventV2 & {
  requestContext: APIGatewayProxyWebsocketEventV2["requestContext"] & {
    authorizer?: { userId?: string; email?: string };
  };
};

export interface Caller {
  connectionId: string;
  userId: string;
  userEmail: string;
}

/**
 * Identifies the sender: API Gateway forwards the authorizer context on every
 * route; the `connections` row is the fallback.
 */
export async function getCaller(event: WsEvent): Promise<Caller | null> {
  const { connectionId, authorizer } = event.requestContext;
  if (authorizer?.userId && authorizer.email) {
    return { connectionId, userId: authorizer.userId, userEmail: authorizer.email };
  }
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.connections,
      Key: { connectionId },
      ProjectionExpression: "userId, userEmail",
    }),
  );
  const row = Item as Pick<ConnectionItem, "userId" | "userEmail"> | undefined;
  return row ? { connectionId, userId: row.userId, userEmail: row.userEmail } : null;
}

/**
 * Wraps a route handler: resolves the caller, logs, and turns unexpected
 * errors into an `INTERNAL_ERROR` event for the sender.
 */
export function wsHandler(fn: (event: WsEvent, caller: Caller) => Promise<HandlerResult>) {
  return async (event: WsEvent): Promise<HandlerResult> => {
    const { connectionId, routeKey } = event.requestContext;
    try {
      const caller = await getCaller(event);
      if (!caller) {
        log.warn("unknown connection", { connectionId, routeKey });
        return await replyError(connectionId, "UNAUTHORIZED");
      }
      log.debug("route", { routeKey, connectionId, userId: caller.userId });
      return await fn(event, caller);
    } catch (err) {
      log.error("handler failed", { routeKey, connectionId, ...errorFields(err) });
      try {
        await replyError(connectionId, "INTERNAL_ERROR");
      } catch {
        // The sender may already be gone; nothing else to do.
      }
      return { statusCode: 500 };
    }
  };
}
