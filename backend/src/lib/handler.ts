import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { GUEST_ROUTES, isRole, type Role } from "@mindfultech/shared";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { ddb, tables, type ConnectionItem } from "./ddb";
import { errorFields, log } from "./logger";
import { replyError, type HandlerResult } from "./response";

/** WebSocket event including the context returned by the `$connect` authorizer. */
export type WsEvent = APIGatewayProxyWebsocketEventV2 & {
  requestContext: APIGatewayProxyWebsocketEventV2["requestContext"] & {
    authorizer?: { userId?: string; email?: string; role?: string };
  };
};

export interface Caller {
  connectionId: string;
  userId: string;
  userEmail: string;
  role: Role;
}

/**
 * Identifies the sender: API Gateway forwards the authorizer context on every
 * route; the `connections` row is the fallback.
 */
export async function getCaller(event: WsEvent): Promise<Caller | null> {
  const { connectionId, authorizer } = event.requestContext;
  if (authorizer?.userId && authorizer.email) {
    return {
      connectionId,
      userId: authorizer.userId,
      userEmail: authorizer.email,
      // Older authorizer contexts carry no role: treat as a member, as before roles.
      role: isRole(authorizer.role) ? authorizer.role : "member",
    };
  }
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.connections,
      Key: { connectionId },
      ProjectionExpression: "userId, userEmail, #role",
      ExpressionAttributeNames: { "#role": "role" },
    }),
  );
  const row = Item as Pick<ConnectionItem, "userId" | "userEmail" | "role"> | undefined;
  if (!row) return null;
  return {
    connectionId,
    userId: row.userId,
    userEmail: row.userEmail,
    role: isRole(row.role) ? row.role : "member",
  };
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
      // Guests only reach their boards: every chat route is closed to them here,
      // before any handler runs (and `deliver` never sends them chat events).
      if (caller.role === "guest" && !GUEST_ROUTES.has(routeKey ?? "")) {
        log.warn("guest blocked", { routeKey, userId: caller.userId });
        return await replyError(connectionId, "FORBIDDEN", "Guests can only use their boards");
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
