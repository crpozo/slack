import { SubscribePushSchema, UnsubscribePushSchema } from "@mindfultech/shared";
import { HttpError, httpHandler, json, notFound, parseBody } from "../lib/http";
import { log } from "../lib/logger";
import { deleteSubscription, saveSubscription } from "../lib/push";
import { vapidConfig } from "../lib/vapid";

/**
 * Web Push subscriptions, on the HTTP API behind the Cognito JWT authorizer:
 *   GET    /push/key        → `{ publicKey }` (503 while the stage has no VAPID keys)
 *   POST   /push/subscribe  `{ subscription }` → 204, saved for the caller (idempotent)
 *   DELETE /push/subscribe  `{ endpoint }`     → 204, e.g. on sign-out
 * Rows are always keyed by the caller's own user id, never by anything in the body.
 */
export const handler = httpHandler(async (event, caller) => {
  switch (event.routeKey) {
    case "GET /push/key": {
      const vapid = await vapidConfig();
      if (!vapid) throw new HttpError(503, "Push notifications aren't set up on this deployment");
      return json(200, { publicKey: vapid.publicKey });
    }
    case "POST /push/subscribe": {
      const { subscription } = parseBody(SubscribePushSchema, event);
      await saveSubscription(caller.userId, subscription, event.headers?.["user-agent"]);
      log.info("push subscription saved", { userId: caller.userId });
      return json(204);
    }
    case "DELETE /push/subscribe": {
      const { endpoint } = parseBody(UnsubscribePushSchema, event);
      await deleteSubscription(caller.userId, endpoint);
      log.info("push subscription removed", { userId: caller.userId });
      return json(204);
    }
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});
