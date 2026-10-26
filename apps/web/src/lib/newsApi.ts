import type { NewsResponse } from "@mindfultech/shared";
import { request } from "./tasksApi";

/**
 * AI News (Phase 35b), on the same HTTP API and auth as the Task Manager.
 * The server answers with `Cache-Control: max-age`, so the browser reuses a
 * response for up to 30 minutes without asking again.
 */
export const newsApi = {
  list: () => request<NewsResponse>("GET", "/news"),
};

export type NewsApi = typeof newsApi;
