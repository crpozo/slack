import { NEWS_CACHE_SECONDS } from "@mindfultech/shared";
import { forbidden, HttpError, httpHandler, notFound, type HttpResult } from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { getNews } from "../lib/news";

/**
 * `GET /news` (Phase 35b): the latest TechCrunch AI articles, read live from
 * the RSS feed. Stateless: no table, no bucket (this Lambda has no data
 * permissions at all); the parsed list stays in the warm container for 30
 * minutes, and browsers are told to keep the response for whatever is left
 * of that (API Gateway HTTP APIs have no response cache of their own).
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  if (event.routeKey !== "GET /news") throw notFound(`No route for ${event.routeKey}`);
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  const now = Date.now();
  let result: Awaited<ReturnType<typeof getNews>>;
  try {
    result = await getNews(fetch, now);
  } catch (err) {
    log.error("news feed unreachable", { ...errorFields(err) });
    throw new HttpError(502, "Couldn't reach TechCrunch right now. Try again in a minute.");
  }
  const { response, fromCache, expiresAt } = result;
  log.info("news served", {
    articles: response.articles.length,
    fromCache,
    ...(response.stale && { stale: true }),
  });
  // The browser keeps it until this container's copy expires (never longer than 30 min).
  const maxAge = Math.max(0, Math.min(NEWS_CACHE_SECONDS, Math.round((expiresAt - now) / 1000)));
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${maxAge}, stale-while-revalidate=600`,
    },
    body: JSON.stringify(response),
  };
});
