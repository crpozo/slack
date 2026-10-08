import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, tables } from "../lib/ddb";
import type { WsEvent } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { ok, type HandlerResult } from "../lib/response";

/** `$disconnect`: best effort — the TTL cleans up anything left behind. */
export const handler = async (event: WsEvent): Promise<HandlerResult> => {
  const { connectionId } = event.requestContext;
  try {
    await ddb.send(new DeleteCommand({ TableName: tables.connections, Key: { connectionId } }));
    log.info("disconnected", { connectionId });
  } catch (err) {
    log.error("disconnect failed", { connectionId, ...errorFields(err) });
  }
  return ok();
};
