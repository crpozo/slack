import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { NewsInsightsResponse } from "@mindfultech/shared";
import { requireEnv } from "../lib/env";
import { forbidden, httpHandler, json, notFound, type HttpResult } from "../lib/http";
import { log } from "../lib/logger";
import { latestInsights } from "../lib/newsInsights";

let lambda: LambdaClient | null = null;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

/**
 * AI Insights (Phase 39), on the same HTTP API as the news.
 *
 * `GET /news/insights`: the latest morning analysis (`null` before the first
 * one). Guests have no news.
 *
 * `POST /news/insights`: an admin asks for a fresh analysis now (the first
 * one after a deploy, or a second look later in the day). The worker is
 * started asynchronously and this answers 202 at once; the view polls for
 * the new row.
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
      await lambdaClient().send(
        new InvokeCommand({
          FunctionName: requireEnv("INSIGHTS_WORKER_FUNCTION"),
          InvocationType: "Event",
          Payload: new TextEncoder().encode(JSON.stringify({ requestedBy: caller.userId })),
        }),
      );
      log.info("news insights requested", { userId: caller.userId });
      return json(202, { queued: true });
    }
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});
