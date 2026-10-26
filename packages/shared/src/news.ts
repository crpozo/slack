// ---------------------------------------------------------------------------
// AI News (Phase 35b): the latest TechCrunch AI articles, read live from the
// feed by a stateless proxy (`GET /news`) and shown as an app view. Nothing is
// stored: the Lambda keeps the parsed list in memory for `NEWS_CACHE_SECONDS`
// and browsers cache the response for as long.
// ---------------------------------------------------------------------------

export const NEWS_FEED_URL = "https://techcrunch.com/category/artificial-intelligence/feed/";
export const NEWS_SOURCE = "TechCrunch";
/** How many articles the view gets, newest first. */
export const NEWS_MAX_ARTICLES = 15;
/** How long a fetched feed is reused (Lambda memory, browser cache). */
export const NEWS_CACHE_SECONDS = 30 * 60;
/** The longest snippet, cut at a word. */
export const NEWS_SNIPPET_CHARS = 220;

export interface NewsArticle {
  title: string;
  /** The article on the publisher's site (https). */
  link: string;
  /** Plain text, no HTML; may be empty. */
  snippet: string;
  /** ISO 8601, or `null` when the feed's date couldn't be read. */
  pubDate: string | null;
  /** https; `null` when the feed has no image for it. */
  imageUrl: string | null;
}

export interface NewsResponse {
  articles: NewsArticle[];
  source: string;
  /** When the feed was read (epoch ms). */
  fetchedAt: number;
  /** The feed couldn't be read just now: this is the last list that could. */
  stale?: boolean;
}
