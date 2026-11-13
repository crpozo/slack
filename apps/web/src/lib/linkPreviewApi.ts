import type { LinkPreview, LinkPreviewResponse } from "@mindfultech/shared";
import { request } from "./tasksApi";

/**
 * Phase 64: link preview cards. One request per link per session: the same
 * link in many messages (or scrolled past twice) shares the answer. The
 * server caches each link for a day, and the browser keeps the answer an hour.
 */
const cache = new Map<string, Promise<LinkPreview | null>>();

export function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = request<LinkPreviewResponse>(
      "GET",
      `/utils/link-preview?url=${encodeURIComponent(url)}`,
    ).then(
      (r) => r.preview,
      () => {
        // A failure isn't remembered: the next time the link shows, it's asked again.
        cache.delete(url);
        return null;
      },
    );
    cache.set(url, pending);
  }
  return pending;
}

/** Tests start from an empty cache. */
export function resetLinkPreviews(): void {
  cache.clear();
}
