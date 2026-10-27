import type { NewsInsightsResponse, NewsResponse } from "@mindfultech/shared";
import { request } from "./tasksApi";

/**
 * AI News (Phase 35b), on the same HTTP API and auth as the Task Manager.
 * The server answers with `Cache-Control: max-age`, so the browser reuses a
 * response for up to 30 minutes without asking again. `refresh` ("Refresh
 * news") asks the server to read the feed again now, past both caches.
 */
export const newsApi = {
  list: (refresh = false) =>
    refresh
      ? request<NewsResponse>("GET", "/news?refresh=1", undefined, { cache: "no-store" })
      : request<NewsResponse>("GET", "/news"),
};

export type NewsApi = typeof newsApi;

/** AI Insights (Phase 39): the morning's analysis, and an admin's request for a fresh one. */
export const newsInsightsApi = {
  latest: () => request<NewsInsightsResponse>("GET", "/news/insights"),
  generate: () => request<{ queued: true }>("POST", "/news/insights"),
};

export type NewsInsightsApi = typeof newsInsightsApi;
