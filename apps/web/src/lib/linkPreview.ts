import type { LinkPreview, LinkPreviewResponse } from "@mindfultech/shared";
import { URL_PATTERN } from "./markdown";
import { request } from "./tasksApi";
import { youTubeVideoOf } from "./youtube";

// ---------------------------------------------------------------------------
// Link previews (Phase 63): the first link of a message shows its page's
// title, description and picture under the text. The server reads the page;
// each link is asked for once per session (and the browser keeps the answer).
// ---------------------------------------------------------------------------

/**
 * The link a message previews: its first https link outside code, unless it
 * is a YouTube video (that one has its own player).
 */
export function previewLinkIn(text: string): string | null {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const [link] of prose.matchAll(URL_PATTERN)) {
    if (!link.startsWith("https://") || youTubeVideoOf(link)) continue;
    return link;
  }
  return null;
}

const asked = new Map<string, Promise<LinkPreview | null>>();

/** The preview of `url`, or `null` when it has none (or it couldn't be read). */
export function loadLinkPreview(url: string): Promise<LinkPreview | null> {
  let pending = asked.get(url);
  if (!pending) {
    pending = request<LinkPreviewResponse>("GET", `/link-preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.preview)
      .catch(() => {
        asked.delete(url); // try again next time it's shown
        return null;
      });
    asked.set(url, pending);
  }
  return pending;
}

/** Tests only. */
export function resetLinkPreviews(): void {
  asked.clear();
}
