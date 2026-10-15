import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PingActionSchema } from "@mindfultech/shared";
import { ddb, tables } from "../lib/ddb";
import type { WsEvent } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import type { HandlerResult } from "../lib/response";

/**
 * `ping`: heartbeat that keeps the WebSocket alive (API Gateway drops
 * connections idle for 10 minutes; any client frame resets that clock) and
 * reports whether the app is in front of the person. `active: true` stamps
 * `activeAt` on the connection row, `false` clears it; a ping without `active`
 * (older clients) touches nothing. No reply: it would cost a PostToConnection.
 * Never fails the frame: activity only decides whether phones get a push.
 */
export const handler = async (event: WsEvent): Promise<HandlerResult> => {
  const { connectionId } = event.requestContext;
  let active: boolean | undefined;
  try {
    active = PingActionSchema.parse(JSON.parse(event.body ?? "{}")).active;
  } catch {
    return { statusCode: 200 };
  }
  if (active === undefined) return { statusCode: 200 };
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.connections,
        Key: { connectionId },
        UpdateExpression: active ? "SET activeAt = :now" : "REMOVE activeAt",
        // Never resurrect a row $disconnect already deleted.
        ConditionExpression: "attribute_exists(connectionId)",
        ...(active && { ExpressionAttributeValues: { ":now": Date.now() } }),
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      log.warn("activity update failed", { connectionId, ...errorFields(err) });
    }
  }
  return { statusCode: 200 };
};
