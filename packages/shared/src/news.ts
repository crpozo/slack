// ---------------------------------------------------------------------------
// AI News (Phase 35b; several sources since Phase 41): the latest AI stories
// from a few publishers' feeds, read live by a stateless proxy (`GET /news`)
// and shown as an app view. Nothing is stored: the Lambda keeps the merged
// list in memory for `NEWS_CACHE_SECONDS` and browsers cache the response for
// as long.
// ---------------------------------------------------------------------------

export interface NewsFeedUrl {
  url: string;
  /** A feed about all of tech, not just AI: only its AI stories are kept. */
  general?: boolean;
}

export interface NewsFeed {
  /** Shown on each story ("InfoQ"). */
  name: string;
  /** Tried in order: the next one only when the one before can't be read. */
  urls: readonly NewsFeedUrl[];
}

export const NEWS_FEEDS: readonly NewsFeed[] = [
  {
    name: "TechCrunch",
    urls: [{ url: "https://techcrunch.com/category/artificial-intelligence/feed/" }],
  },
  {
    name: "VentureBeat",
    urls: [
      { url: "https://venturebeat.com/category/ai/feed/" },
      { url: "https://feeds.feedburner.com/venturebeat/SZYF", general: true },
    ],
  },
  {
    name: "The Verge",
    urls: [{ url: "https://www.theverge.com/rss/index.xml", general: true }],
  },
  {
    name: "InfoQ",
    urls: [{ url: "https://feed.infoq.com/ai-ml-data-eng/news" }],
  },
];

/** How many articles the view gets, newest first. */
export const NEWS_MAX_ARTICLES = 40;
/** The most stories one source may have in the list, so a busy one can't crowd out the rest. */
export const NEWS_MAX_PER_SOURCE = 12;
/**
 * Only news: a story published longer ago than this (or with no date we can
 * read) is dropped as the feed is read, before any limit and before the
 * daily AI Insights see it. Feeds keep weeks of stories; this keeps them out.
 */
export const NEWS_MAX_AGE_HOURS = 48;
export const NEWS_MAX_AGE_MS = NEWS_MAX_AGE_HOURS * 60 * 60 * 1000;
/** A date further ahead than this is a feed's mistake, not news: treated as no date. */
export const NEWS_FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
/** How long a fetched list is reused (Lambda memory, browser cache). */
export const NEWS_CACHE_SECONDS = 30 * 60;
/**
 * "Refresh news": the feeds are read again unless they were read this
 * recently (one container, many clicks; each source posts a few stories an hour).
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
  /** The publisher, as in `NEWS_FEEDS` ("The Verge"). */
  sourceName: string;
}

export interface NewsResponse {
  articles: NewsArticle[];
  /** The publishers whose feeds were read, comma-separated ("TechCrunch, InfoQ"). */
  source: string;
  /** When the feed was read (epoch ms). */
  fetchedAt: number;
  /** No feed could be read just now: this is the last list that could. */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// AI Insights (Phase 39; structured since Phase 41): every morning a worker
// reads the same feeds and asks Claude Haiku 5.5 on Amazon Bedrock for the
// day's dashboard as JSON: the top stories (headline and summary in Spanish),
// the trends behind them and what they mean for the team. One row per day is
// kept (`slack-<stage>-news-insights`); the News view shows the latest, and
// an admin can ask for a fresh one.
// ---------------------------------------------------------------------------

/** The language the analysis is written in (the team's). */
export const NEWS_INSIGHTS_LANGUAGE = "Spanish";
/** The team's time zone: decides which calendar day an analysis belongs to. */
export const NEWS_INSIGHTS_TIME_ZONE = "America/Guayaquil";
/** When the morning analysis runs, in that time zone (the infra's schedule says the same). */
export const NEWS_INSIGHTS_LOCAL_TIME = "08:00";
/**
 * The partition key of every row. It named the one feed there was; it stays
 * as it is now that the analysis reads every source, so the rows already
 * written are still the history.
 */
export const NEWS_INSIGHTS_FEED = "techcrunch-ai";
/** How long the view waits for a requested analysis before giving up. */
export const NEWS_INSIGHTS_WAIT_MS = 90_000;

/** A story the analysis read (title and link only: the stories aren't stored twice). */
export interface NewsInsightsArticle {
  title: string;
  link: string;
}

/** How many stories "Lo esencial" picks. */
export const NEWS_INSIGHTS_TOP_STORIES = 6;
/** How many trends "Tendencias" has, at most. */
export const NEWS_INSIGHTS_MAX_TRENDS = 4;
/** How many takeaways "Qué significa para MindfulTech" has, at most. */
export const NEWS_INSIGHTS_MAX_TAKEAWAYS = 5;
/** How many items "Para seguir de cerca" has, at most (Phase 44). */
export const NEWS_INSIGHTS_MAX_WATCHLIST = 4;
/** How many implications and open questions "A fondo" lists, at most (Phase 44). */
export const NEWS_INSIGHTS_DEEP_DIVE_POINTS = 3;

/**
 * A story as the dashboard shows it: the headline and summary are the
 * model's (in Spanish); the rest is the feed's, never the model's.
 */
export interface NewsStory {
  headline: string;
  /** One or two sentences. */
  summary: string;
  /**
   * Phase 44: why it matters beyond what happened (who it affects, what
   * changes); one or two sentences. Absent on live stories and older analyses.
   */
  whyItMatters?: string;
  /** The publisher ("InfoQ"). */
  sourceName: string;
  /** The article on the publisher's site (https). */
  link: string;
  /** https; `null` when the feed had no image for it. */
  thumbnailUrl: string | null;
  /** ISO 8601, or `null`. */
  pubDate: string | null;
}

/** A story a trend rests on (Phase 44): the feed's title and link, never the model's. */
export interface NewsEvidence {
  title: string;
  link: string;
  sourceName: string;
}

/** A pattern behind the day's stories. */
export interface NewsTrend {
  /** One or two words ("Agentes"). */
  topic: string;
  /** A short paragraph; the key phrases are marked `**like this**` (plain text otherwise). */
  text: string;
  /** Phase 44: the stories it rests on, in the analysis's order. */
  evidence?: NewsEvidence[];
}

/** When a takeaway applies (Phase 44): act now, plan for the quarter, or keep an eye on it. */
export const NEWS_HORIZONS = ["ahora", "trimestre", "vigilar"] as const;
export type NewsHorizon = (typeof NEWS_HORIZONS)[number];

/** What the news means for the team: a bold lead and the rest of the sentence. */
export interface NewsTakeaway {
  /** "Evaluar modelos on-device" */
  lead: string;
  /** "para la app de bienestar: reduce costos de API…" */
  body: string;
  /** Phase 44. */
  horizon?: NewsHorizon;
}

/**
 * "A fondo" (Phase 44): the day's most important story taken apart: the
 * background, what it changes for a small AI product team, and what is
 * still unknown. Link and source are the feed's.
 */
export interface NewsDeepDive {
  headline: string;
  link: string;
  sourceName: string;
  /** Three or four sentences of background and what changed. */
  context: string;
  /** Concrete implications, up to `NEWS_INSIGHTS_DEEP_DIVE_POINTS`. */
  implications: string[];
  /** Open questions, up to `NEWS_INSIGHTS_DEEP_DIVE_POINTS`. */
  questions: string[];
}

/** "Para seguir de cerca" (Phase 44): a thing to watch and why. */
export interface NewsWatchItem {
  /** Two to four words ("Precios de inferencia"). */
  topic: string;
  /** One or two sentences: what to look for and what it would mean. */
  text: string;
}

export interface NewsInsights {
  /** `YYYY-MM-DD` in `NEWS_INSIGHTS_TIME_ZONE`. */
  day: string;
  /** When it was written (epoch ms). */
  generatedAt: number;
  /** How many stories the model read. */
  storyCount: number;
  /** "Lo esencial": the day's top stories, most important first. */
  stories: NewsStory[];
  /** "Tendencias". */
  trends: NewsTrend[];
  /** "Qué significa para MindfulTech". */
  takeaways: NewsTakeaway[];
  /** "A fondo" (Phase 44); absent on older analyses. */
  deepDive?: NewsDeepDive;
  /** "Para seguir de cerca" (Phase 44); absent on older analyses. */
  watchlist?: NewsWatchItem[];
  /** The stories it read, newest first. */
  articles: NewsInsightsArticle[];
  /** The publishers they came from, comma-separated. */
  source: string;
}

/**
 * "Refresh news" (`POST /news/refresh`) starts a new analysis at once, but
 * not more often than this for members (admins aren't held to it): every
 * click is a model run, and an analysis takes about half a minute.
 */
export const NEWS_REFRESH_COOLDOWN_SECONDS = 5 * 60;

/** `POST /news/refresh`: a new analysis was started, or one was started too recently. */
export interface NewsRefreshResponse {
  queued: boolean;
  /** When `queued` is false: how long until the next one may be started. */
  retryAfterSeconds?: number;
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
