import { SEARCH_MAX_QUERY } from "@mindfultech/shared";
import { scanChannels, visibleTo } from "../lib/channels";
import { forbidden, HttpError, httpHandler, json, notFound, type HttpResult } from "../lib/http";
import { log } from "../lib/logger";
import { searchMessages } from "../lib/search";

/**
 * `GET /search?q=…[&channelId=…]` (Phase 42): messages containing every word
 * of `q` (each as a word's start), in the conversations the caller can see
 * (public channels, and the private ones and DMs they belong to; archived
 * ones too), or in `channelId` alone. Newest first, with a snippet around
 * the match. Secrets and deleted messages are never indexed. Guests, who
 * only see their boards, can't search.
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  if (event.routeKey !== "GET /search") throw notFound(`No route for ${event.routeKey}`);
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  const q = (event.queryStringParameters?.q ?? "").trim();
  if (!q) throw new HttpError(400, "Missing q");
  if (q.length > SEARCH_MAX_QUERY) {
    throw new HttpError(400, `The search can be at most ${SEARCH_MAX_QUERY} characters`);
  }
  const only = event.queryStringParameters?.channelId;
  const visible = visibleTo(await scanChannels(), caller.userId);
  const channels = only ? visible.filter((c) => c.channelId === only) : visible;
  // A conversation you can't see is indistinguishable from one that doesn't exist.
  if (only && channels.length === 0) throw notFound("Conversation not found");

  const started = Date.now();
  const response = await searchMessages(q, channels);
  log.info("search", {
    terms: response.terms.length,
    channels: channels.length,
    results: response.results.length,
    truncated: response.truncated,
    ms: Date.now() - started,
  });
  return json(200, response);
});
