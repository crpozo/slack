import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { NewsInsightsResponse, NewsRefreshResponse } from "@mindfultech/shared";
import { requireEnv } from "../lib/env";
import { forbidden, httpHandler, json, notFound, type HttpResult } from "../lib/http";
import { log } from "../lib/logger";
import { claimRefresh, latestInsights } from "../lib/newsInsights";

let lambda: LambdaClient | null = null;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

/**
 * AI Insights (Phase 39), on the same HTTP API as the news.
 *
 * `GET /news/insights`: the latest morning analysis (`null` before the first
 * one). Guests have no news.
 *
 * `POST /news/refresh` ("Refresh news"): a fresh analysis now, whatever the
 * time: the worker reads every feed and asks the model. A member may start
 * one every `NEWS_REFRESH_COOLDOWN_SECONDS` (one atomic claim, so a burst of
 * clicks starts one run; otherwise 200 `{queued: false, retryAfterSeconds}`);
 * an admin, any time. The worker is started asynchronously and this answers
 * 202 at once; the view polls for the new row.
 *
 * `POST /news/insights`: the same for admins only, without the claim (what
 * tabs opened before "Refresh news" did this still call).
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  switch (event.routeKey) {
    case "GET /news/insights": {
      const body: NewsInsightsResponse = { insights: await latestInsights() };
      return json(200, body);
    }
    case "POST /news/insights": {
      if (caller.role !== "admin") throw forbidden("Only an admin can ask for a new analysis");
      await startWorker(caller.userId);
      log.info("news insights requested", { userId: caller.userId });
      return json(202, { queued: true });
    }
    case "POST /news/refresh": {
      const admin = caller.role === "admin";
      const claim = await claimRefresh(caller.userId, Date.now(), admin);
      if (!claim.ok) {
        const body: NewsRefreshResponse = {
          queued: false,
          retryAfterSeconds: claim.retryAfterSeconds,
        };
        return json(200, body);
      }
      await startWorker(caller.userId);
      log.info("news refresh requested", { userId: caller.userId, admin });
      const body: NewsRefreshResponse = { queued: true };
      return json(202, body);
    }
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});

/** Starts the worker without waiting for it (it writes the row in about half a minute). */
async function startWorker(requestedBy: string): Promise<void> {
  await lambdaClient().send(
    new InvokeCommand({
      FunctionName: requireEnv("INSIGHTS_WORKER_FUNCTION"),
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify({ requestedBy })),
    }),
  );
}
