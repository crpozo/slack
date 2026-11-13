import { extractLinks } from "./media";

// ---------------------------------------------------------------------------
// Phase 64: link previews. The server fetches a shared page (a browser can't:
// CORS), reads its Open Graph tags (og:title, og:description, og:image,
// og:site_name, with <title> and the description meta as fallbacks) and
// answers a small card's worth of data, cached for a day.
// ---------------------------------------------------------------------------

/** URLs longer than this aren't previewed. */
export const MAX_PREVIEW_URL_LENGTH = 2048;
export const MAX_PREVIEW_TITLE = 200;
export const MAX_PREVIEW_DESCRIPTION = 300;

export interface LinkPreview {
  /** The page as shared (after following redirects, it may differ from what was asked). */
  url: string;
  title: string;
  description?: string;
  /** https only. */
  image?: string;
  siteName?: string;
  /** `example.com` (no `www.`). */
  domain: string;
}

/** `GET /utils/link-preview?url=…`: `null` when the page has nothing to show. */
export interface LinkPreviewResponse {
  preview: LinkPreview | null;
}

/** Whether `url` may be asked about: http(s), not too long, no credentials in it. */
export function isPreviewableUrl(url: string): boolean {
  if (url.length > MAX_PREVIEW_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !!parsed.hostname
    );
  } catch {
    return false;
  }
}

/**
 * The link a message's preview card is for: its first previewable link,
 * skipping the ones `skip` says already have their own preview (YouTube).
 */
export function previewLinkOf(text: string, skip: (url: string) => boolean = () => false) {
  return extractLinks(text).find((url) => isPreviewableUrl(url) && !skip(url)) ?? null;
}
