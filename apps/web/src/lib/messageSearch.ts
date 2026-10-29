// Message search (Phase 42): the client side of `GET /search`, debounced so
// typing doesn't send a request per key. Pure apart from the timer, tested.

import { searchTerms, type SearchResponse } from "@mindfultech/shared";
import { request } from "./tasksApi";

/** How long typing must pause before the search is sent. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Queries answered recently, reused as-is (backspacing, retyping). */
const CACHE_SIZE = 20;

export const searchApi = {
  search: (q: string, channelId?: string) =>
    request<SearchResponse>(
      "GET",
      `/search?q=${encodeURIComponent(q)}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ""}`,
    ),
};

export type SearchApi = typeof searchApi;

export type MessageSearchState =
  /** Nothing to search: empty, or only short and common words. */
  | { status: "idle" }
  /** Waiting for the pause or the answer; the previous answer stays on screen meanwhile. */
  | { status: "loading"; query: string; previous?: SearchResponse }
  | { status: "done"; query: string; response: SearchResponse }
  | { status: "error"; query: string; error: string };

/**
 * A search box's requests: `update(query)` on every keystroke sends one
 * request after `delayMs` without typing, and only the newest query's answer
 * is ever reported (an older one arriving late is dropped). Answers are kept
 * for the last few queries, so going back to one is instant.
 */
export function createMessageSearch(
  run: (query: string) => Promise<SearchResponse>,
  onChange: (state: MessageSearchState) => void,
  delayMs = SEARCH_DEBOUNCE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;
  let shown: SearchResponse | undefined;
  const cache = new Map<string, SearchResponse>();

  const report = (state: MessageSearchState) => {
    if (state.status === "done") shown = state.response;
    if (state.status === "idle") shown = undefined;
    onChange(state);
  };

  return {
    update(raw: string) {
      clearTimeout(timer);
      const id = ++latest;
      const query = raw.trim().replace(/\s+/g, " ");
      if (searchTerms(query).length === 0) return report({ status: "idle" });
      const key = query.toLowerCase();
      const cached = cache.get(key);
      if (cached) return report({ status: "done", query, response: cached });
      report({ status: "loading", query, previous: shown });
      timer = setTimeout(async () => {
        try {
          const response = await run(query);
          cache.set(key, response);
          if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
          if (id === latest) report({ status: "done", query, response });
        } catch (err) {
          if (id !== latest) return;
          report({
            status: "error",
            query,
            error: err instanceof Error && err.message ? err.message : "The search failed.",
          });
        }
      }, delayMs);
    },
    /** Stops a pending request (the palette closed). */
    dispose() {
      clearTimeout(timer);
      latest++;
    },
  };
}
