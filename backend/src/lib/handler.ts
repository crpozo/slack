import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { EXTERNAL_ROUTES, GUEST_ROUTES, isRole, type Role } from "@mindfultech/shared";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { ddb, tables, type ConnectionItem } from "./ddb";
import { errorFields, log } from "./logger";
import { replyError, type HandlerResult } from "./response";

/** WebSocket event including the context returned by the `$connect` authorizer. */
export type WsEvent = APIGatewayProxyWebsocketEventV2 & {
  requestContext: APIGatewayProxyWebsocketEventV2["requestContext"] & {
    authorizer?: {
      userId?: string;
      email?: string;
      role?: string;
      /** Phase 59: `"1"` for an external (a call link); then the call and their name. */
      external?: string;
      callScope?: string;
      callRoomId?: string;
      name?: string;
    };
  };
};

/** Phase 59: the one call an external's connection is for, and the name they gave. */
export interface ExternalScope {
  channelId: string;
  roomId: string;
  name: string;
}

export interface Caller {
  connectionId: string;
  userId: string;
  userEmail: string;
  role: Role;
  /** Phase 59: set for an external (role `guest`, no account, one call). */
  external?: ExternalScope;
}

/**
 * Identifies the sender: API Gateway forwards the authorizer context on every
 * route; the `connections` row is the fallback.
 */
export async function getCaller(event: WsEvent): Promise<Caller | null> {
  const { connectionId, authorizer } = event.requestContext;
  if (authorizer?.userId && authorizer.external === "1") {
    if (!authorizer.callScope || !authorizer.callRoomId) return null;
    return {
      connectionId,
      userId: authorizer.userId,
      userEmail: "",
      role: "guest",
      external: {
        channelId: authorizer.callScope,
        roomId: authorizer.callRoomId,
        name: authorizer.name ?? "",
      },
    };
  }
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
      ProjectionExpression: "userId, userEmail, #role, external, callScope, callRoomId, #name",
      ExpressionAttributeNames: { "#role": "role", "#name": "name" },
    }),
  );
  const row = Item as
    | Pick<
        ConnectionItem,
        "userId" | "userEmail" | "role" | "external" | "callScope" | "callRoomId" | "name"
      >
    | undefined;
  if (!row) return null;
  if (row.external) {
    if (!row.callScope || !row.callRoomId) return null;
    return {
      connectionId,
      userId: row.userId,
      userEmail: "",
      role: "guest",
      external: { channelId: row.callScope, roomId: row.callRoomId, name: row.name ?? "" },
    };
  }
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
      // Phase 59: an external's connection is for one call: its signals and the
      // heartbeat, nothing else (and `deliver` sends it nothing else).
      if (caller.external && !EXTERNAL_ROUTES.has(routeKey ?? "")) {
        log.warn("external blocked", { routeKey, userId: caller.userId });
        return await replyError(connectionId, "FORBIDDEN", "This link is for the call only");
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
