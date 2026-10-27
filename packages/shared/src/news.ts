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
/**
 * "Refresh news": the feed is read again unless it was read this recently
 * (one container, many clicks; TechCrunch posts a few stories an hour).
 */
export const NEWS_REFRESH_MIN_SECONDS = 60;
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

// ---------------------------------------------------------------------------
// AI Insights (Phase 39): every morning a worker reads the same feed and asks
// Claude Haiku 5.5 on Amazon Bedrock for an analysis of the day's stories:
// what matters, the trends behind them and what they mean for the team. One
// row per day is kept (`slack-<stage>-news-insights`); the News view shows
// the latest, and an admin can ask for a fresh one.
// ---------------------------------------------------------------------------

/** The language the analysis is written in (the team's). */
export const NEWS_INSIGHTS_LANGUAGE = "Spanish";
/** The team's time zone: decides which calendar day an analysis belongs to. */
export const NEWS_INSIGHTS_TIME_ZONE = "America/Guayaquil";
/** When the morning analysis runs, in that time zone (the infra's schedule says the same). */
export const NEWS_INSIGHTS_LOCAL_TIME = "07:07";
/** The feed, as stored (the partition key of every row). */
export const NEWS_INSIGHTS_FEED = "techcrunch-ai";
/** How long the view waits for a requested analysis before giving up. */
export const NEWS_INSIGHTS_WAIT_MS = 90_000;

/** A story the analysis read (title and link only: the stories aren't stored twice). */
export interface NewsInsightsArticle {
  title: string;
  link: string;
}

export interface NewsInsights {
  /** `YYYY-MM-DD` in `NEWS_INSIGHTS_TIME_ZONE`. */
  day: string;
  /** Markdown from the model. */
  analysis: string;
  /** When it was written (epoch ms). */
  generatedAt: number;
  /** The stories it read, newest first. */
  articles: NewsInsightsArticle[];
  source: string;
}

/** `GET /news/insights`: the latest analysis, or `null` before the first one. */
export interface NewsInsightsResponse {
  insights: NewsInsights | null;
}

/** `ms` as a `YYYY-MM-DD` calendar day in `timeZone`. */
export function calendarDay(ms: number, timeZone = NEWS_INSIGHTS_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}
