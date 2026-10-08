import { CLIENT_ACTIONS } from "@mindfultech/shared";
import type { WsEvent } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { badRequest, type HandlerResult } from "../lib/response";

/** `$default`: any frame whose `action` matches no route. */
export const handler = async (event: WsEvent): Promise<HandlerResult> => {
  const { connectionId } = event.requestContext;
  log.info("unknown action", { connectionId });
  try {
    return await badRequest(
      connectionId,
      `Unknown action. Expected one of: ${CLIENT_ACTIONS.join(", ")}`,
    );
  } catch (err) {
    log.error("default reply failed", { connectionId, ...errorFields(err) });
    return { statusCode: 500 };
  }
};
