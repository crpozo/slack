import Anthropic from "@anthropic-ai/sdk";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  AskNewsSchema,
  type AskNewsResponse,
  type NewsInsightsResponse,
  type NewsRefreshResponse,
} from "@mindfultech/shared";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { requireEnv } from "../lib/env";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { getNews } from "../lib/news";
import { newsAnswerFrom, newsChatRequest } from "../lib/newsChat";
import { claimRefresh, lastFailure, latestInsights } from "../lib/newsInsights";

let chatModel: ClaudeModel | null = null;

/** Tests swap the model. */
export function useNewsChatModel(next: ClaudeModel | null): void {
  chatModel = next;
}

/** One try, inside API Gateway's 30 seconds (the feeds may need reading first). */
const CHAT_TIMEOUT_MS = 22_000;

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
      const [insights, failure] = await Promise.all([latestInsights(), lastFailure()]);
      const body: NewsInsightsResponse = {
        insights,
        // Only a failure after the analysis on screen is news to the page.
        ...(failure && failure.at > (insights?.generatedAt ?? 0) && { failure }),
      };
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
    case "POST /news/ask":
      return askNews(event, caller.userId);
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

/**
 * `POST /news/ask` (Phase 50): answers a question about today's news from the
 * stories (this container's copy, read from the feeds when stale) and the
 * morning's analysis, with the chat so far. Nothing is stored.
 */
async function askNews(
  event: Parameters<Parameters<typeof httpHandler>[0]>[0],
  userId: string,
): Promise<HttpResult> {
  const { question, history } = parseBody(AskNewsSchema, event);
  const [news, insights] = await Promise.all([
    getNews(fetch, Date.now()).catch(() => null),
    latestInsights(),
  ]);
  const articles = news?.response.articles ?? [];
  if (articles.length === 0 && !insights) {
    throw new HttpError(503, "No hay noticias para consultar ahora mismo. Intenta en un minuto.");
  }
  const started = Date.now();
  let response: Anthropic.Message;
  try {
    response = await (chatModel ??= bedrockModel(CHAT_TIMEOUT_MS, 0)).create(
      newsChatRequest(articles, insights, history, question),
    );
  } catch (err) {
    log.error("news question failed", {
      userId,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    throw new HttpError(
      err instanceof Anthropic.RateLimitError ? 503 : 502,
      "No se pudo responder ahora. Intenta de nuevo.",
    );
  }
  const answered = newsAnswerFrom(response, articles);
  log.info("news question answered", {
    userId,
    ok: answered !== null,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
    ms: Date.now() - started,
  });
  if (!answered)
    throw new HttpError(502, "No llegó una respuesta. Prueba a preguntarlo de otra forma.");
  const body: AskNewsResponse = answered;
  return json(200, body);
}
