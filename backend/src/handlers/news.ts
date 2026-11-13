import { NEWS_CACHE_SECONDS, type LinkPreviewResponse } from "@mindfultech/shared";
import { forbidden, HttpError, httpHandler, notFound, type HttpResult } from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { linkPreview } from "../lib/linkPreview";
import { getNews } from "../lib/news";

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
};

/**
 * `GET /news` (Phase 35b; several sources since Phase 41): the latest AI
 * articles from TechCrunch, VentureBeat, The Verge and InfoQ, read live from
 * their feeds and merged. Stateless: no table, no bucket (this Lambda has no data
 * permissions at all); the parsed list stays in the warm container for 30
 * minutes, and browsers are told to keep the response for whatever is left
 * of that (API Gateway HTTP APIs have no response cache of their own).
 * `?refresh=1` ("Refresh news") reads the feed again now (at most once a
 * minute per container) and is never cached by the browser.
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  // Phase 63: a link's preview for a message (this Lambda already reads the web and
  // holds no data permissions, so a hostile page has nothing to reach from here).
  if (event.routeKey === "GET /link-preview") {
    const url = event.queryStringParameters?.url ?? "";
    if (!url) throw new HttpError(400, "url is required");
    const preview = await linkPreview(url);
    log.info("link preview", { host: hostOf(url), found: !!preview });
    const body: LinkPreviewResponse = { preview };
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        // Per person (it's behind their sign-in); a page's preview rarely changes.
        "cache-control": `private, max-age=${preview ? 86_400 : 600}`,
      },
      body: JSON.stringify(body),
    };
  }
  if (event.routeKey !== "GET /news") throw notFound(`No route for ${event.routeKey}`);
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  const now = Date.now();
  const refresh = event.queryStringParameters?.refresh === "1";
  let result: Awaited<ReturnType<typeof getNews>>;
  try {
    result = await getNews(fetch, now, refresh);
  } catch (err) {
    log.error("news feed unreachable", { ...errorFields(err) });
    throw new HttpError(502, "Couldn't reach the news sources right now. Try again in a minute.");
  }
  const { response, fromCache, expiresAt, failed, discarded } = result;
  // A source that's down is left out of the list; worth knowing which, and why.
  if (failed && failed.length > 0) log.warn("news sources unreachable", { failed });
  // Stories older than NEWS_MAX_AGE_HOURS (or undated) never make the list.
  if (discarded && discarded.length > 0) log.info("old news discarded", { discarded });
  log.info("news served", {
    articles: response.articles.length,
    fromCache,
    ...(refresh && { refresh: true }),
    ...(response.stale && { stale: true }),
  });
  // The browser keeps it until this container's copy expires (never longer than 30 min).
  const maxAge = Math.max(0, Math.min(NEWS_CACHE_SECONDS, Math.round((expiresAt - now) / 1000)));
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": refresh
        ? "no-store"
        : `public, max-age=${maxAge}, stale-while-revalidate=600`,
    },
    body: JSON.stringify(response),
  };
});
