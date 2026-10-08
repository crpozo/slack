import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, tables, type ConnectionItem } from "../lib/ddb";
import type { WsEvent } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { ok, type HandlerResult } from "../lib/response";

const CONNECTION_TTL_SECONDS = 2 * 60 * 60;

/** `$connect`: the authorizer already validated the token; store the connection. */
export const handler = async (event: WsEvent): Promise<HandlerResult> => {
  const { connectionId, authorizer } = event.requestContext;
  if (!authorizer?.userId || !authorizer.email) {
    log.warn("connect without authorizer context", { connectionId });
    return { statusCode: 401 };
  }

  const now = Date.now();
  const item: ConnectionItem = {
    connectionId,
    userId: authorizer.userId,
    userEmail: authorizer.email,
    connectedAt: now,
    ttl: Math.floor(now / 1000) + CONNECTION_TTL_SECONDS,
  };

  try {
    await ddb.send(new PutCommand({ TableName: tables.connections, Item: item }));
  } catch (err) {
    log.error("connect failed", { connectionId, ...errorFields(err) });
    return { statusCode: 500 };
  }
  log.info("connected", { connectionId, userId: item.userId });
  return ok();
};
