import { z } from "zod";
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
  // Phase 62: the publications the industry itself reads. A source that
  // doesn't answer (a paywall, a moved feed) is skipped; the rest still load.
  {
    name: "Bloomberg",
    urls: [{ url: "https://feeds.bloomberg.com/technology/news.rss", general: true }],
  },
  {
    name: "Financial Times",
    urls: [{ url: "https://www.ft.com/artificial-intelligence?format=rss" }],
  },
  {
    name: "The New York Times",
    urls: [{ url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", general: true }],
  },
  {
    name: "MIT Technology Review",
    urls: [
      { url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
      { url: "https://www.technologyreview.com/feed/", general: true },
    ],
  },
  {
    name: "Wired",
    urls: [
      { url: "https://www.wired.com/feed/tag/ai/latest/rss" },
      { url: "https://www.wired.com/feed/rss", general: true },
    ],
  },
  {
    name: "Ars Technica",
    urls: [
      { url: "https://arstechnica.com/ai/feed/" },
      { url: "https://feeds.arstechnica.com/arstechnica/index", general: true },
    ],
  },
  {
    name: "The Guardian",
    urls: [{ url: "https://www.theguardian.com/technology/artificialintelligenceai/rss" }],
  },
  {
    name: "CNBC",
    urls: [{ url: "https://www.cnbc.com/id/19854910/device/rss/rss.html", general: true }],
  },
  // First-hand: what the labs themselves announce.
  { name: "OpenAI", urls: [{ url: "https://openai.com/news/rss.xml" }] },
  { name: "Google DeepMind", urls: [{ url: "https://deepmind.google/blog/rss.xml" }] },
];

/** How many articles the view gets, newest first. */
export const NEWS_MAX_ARTICLES = 40;
/** The most stories one source may have in the list, so a busy one can't crowd out the rest. */
export const NEWS_MAX_PER_SOURCE = 8;
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

/** One publisher of `NEWS_FEEDS`, as the last read found it. */
export interface NewsSourceStatus {
  name: string;
  /** Its feed answered. */
  connected: boolean;
  /** How many of its stories are in the list now. */
  stories: number;
}

export interface NewsResponse {
  articles: NewsArticle[];
  /** Phase 62: every source and whether it answered (absent on older cached answers). */
  sources?: NewsSourceStatus[];
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
export const NEWS_INSIGHTS_LOCAL_TIME = "06:00";
/**
 * The partition key of every row. It named the one feed there was; it stays
 * as it is now that the analysis reads every source, so the rows already
 * written are still the history.
 */
export const NEWS_INSIGHTS_FEED = "techcrunch-ai";
/** How long the view waits for a requested analysis before giving up. */
export const NEWS_INSIGHTS_WAIT_MS = 7 * 60_000;

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
  /** Phase 62: a concrete way MindfulTech could do it (absent on older analyses). */
  example?: string;
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
  /**
   * Phase 54: the summary read aloud in Spanish (an MP3 behind a presigned URL,
   * valid for a while); absent until it's made, and on older analyses.
   */
  audio?: NewsAudio;
  /**
   * Phase 56: today's stories say Anthropic is about to release a new Claude
   * model, or just did. Absent on most days, and on older analyses.
   */
  claudeAlert?: ClaudeModelAlert;
}

// ---------------------------------------------------------------------------
// Phase 56: an alert when Anthropic is about to release a new Claude model,
// or has just released one. From the morning's analysis (the model reads the
// stories) and, between analyses, from the live headlines.
// ---------------------------------------------------------------------------

export const CLAUDE_MODEL_STATUSES = ["upcoming", "launched"] as const;
/** "upcoming": announced, previewed, leaked or expected soon; "launched": out now. */
export type ClaudeModelStatus = (typeof CLAUDE_MODEL_STATUSES)[number];

export interface ClaudeModelAlert {
  status: ClaudeModelStatus;
  /** The model's name as the stories give it ("Claude Opus 6"); "" when they don't name it. */
  model: string;
  /** One line (Spanish from the analysis; the publisher's own title from the live headlines). */
  headline: string;
  /** A sentence or two on what was announced and when; may be empty. */
  summary: string;
  /** The stories that say so (the feed's titles and links), at least one. */
  evidence: NewsEvidence[];
  /** Where it came from: the morning's analysis, or a live headline. */
  from: "analysis" | "headline";
}

/** A story about Anthropic or Claude (only these can raise the alert). */
export const CLAUDE_STORY = /\b(anthropic|claude)\b/i;
/**
 * Whole words, accents included (`\\b` stops at "ó"): `words("lanzó")`. No
 * lookbehind: older Safari (iPhones) rejects it, and that would break the app.
 */
const words = (alternatives: string) =>
  new RegExp(`(?:^|[^\\p{L}\\d])(?:${alternatives})(?![\\p{L}\\d])`, "iu");
/** A model, not an app or a feature: a family name, a version number, "new model". */
const CLAUDE_MODEL_WORDS = words(
  [
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "mythos",
    "claude\\s+\\d+(?:\\.\\d+)?",
    "new (?:ai |frontier |flagship )?models?",
    "next[- ]gen(?:eration)?(?: model)?",
    "nuevos? modelos?",
    "pr[oó]ximo modelo",
    "siguiente modelo",
  ].join("|"),
);
const LAUNCHED_WORDS = words(
  [
    "launch(?:es|ed)?",
    "releas(?:es|ed)",
    "introduc(?:es|ed|ing)",
    "unveil(?:s|ed)?",
    "debut(?:s|ed)?",
    "rolls? out",
    "rolled out",
    "ships",
    "now available",
    "is here",
    "arrives?",
    "lanza",
    "lanzó",
    "presenta",
    "presentó",
    "ya disponible",
    "llega",
  ].join("|"),
);
const UPCOMING_WORDS = words(
  [
    "coming",
    "soon",
    "upcoming",
    "prepar(?:es|ing)",
    "readies",
    "readying",
    "plans? to",
    "set to (?:launch|release)",
    "teas(?:es|ed|er)",
    "leak(?:s|ed)?",
    "rumou?rs?",
    "reportedly",
    "expected",
    "próximo",
    "pronto",
    "prepara",
    "planea",
    "filtra(?:do|ción)?",
  ].join("|"),
);

/** "Claude Opus 6", "Claude 5", "Claude Sonnet" — the model a headline names, or "". */
export function claudeModelName(text: string): string {
  const named = /\bClaude\s+(Opus|Sonnet|Haiku|Fable|Mythos)(\s+\d+(\.\d+)?)?\b/i.exec(text);
  if (named) return named[0].replace(/\s+/g, " ");
  const numbered = /\bClaude\s+\d+(\.\d+)?\b/i.exec(text);
  return numbered ? numbered[0].replace(/\s+/g, " ") : "";
}

/**
 * What a headline says about a new Claude model: "launched", "upcoming", or
 * `null` (not about Anthropic or Claude, or not about a new model). A word
 * of the future ("set to launch", "soon") makes it upcoming, whatever verb
 * comes with it.
 */
export function claudeModelSignal(
  article: Pick<NewsArticle, "title" | "snippet">,
): ClaudeModelStatus | null {
  const title = article.title;
  if (!CLAUDE_STORY.test(title)) return null;
  const text = `${title} ${article.snippet}`;
  if (!CLAUDE_MODEL_WORDS.test(text)) return null;
  if (UPCOMING_WORDS.test(title)) return "upcoming";
  if (LAUNCHED_WORDS.test(title)) return "launched";
  return null;
}

/**
 * The live headlines' alert (between analyses): the newest story that says a
 * Claude model is out ("launched" wins over "upcoming"), with any other story
 * saying the same as evidence. `null` when none does.
 */
export function claudeAlertFromArticles(articles: NewsArticle[]): ClaudeModelAlert | null {
  for (const status of ["launched", "upcoming"] as const) {
    const matching = articles.filter((a) => claudeModelSignal(a) === status);
    const [first] = matching;
    if (!first) continue;
    const summary = first.snippet.replace(/\s+/g, " ").trim();
    return {
      status,
      model: claudeModelName(`${first.title} ${first.snippet}`),
      headline: first.title,
      summary: summary.length > 240 ? `${summary.slice(0, 237).trimEnd()}…` : summary,
      evidence: matching
        .slice(0, 3)
        .map(({ title, link, sourceName }) => ({ title, link, sourceName })),
      from: "headline",
    };
  }
  return null;
}

/**
 * The alert to show: a launch beats an upcoming one (the news moved on), and
 * between two of the same kind the analysis's (written in Spanish, read in
 * context) beats a headline's.
 */
export function pickClaudeAlert(
  ...alerts: Array<ClaudeModelAlert | null | undefined>
): ClaudeModelAlert | null {
  const present = alerts.filter((a): a is ClaudeModelAlert => !!a);
  return (
    present.find((a) => a.status === "launched" && a.from === "analysis") ??
    present.find((a) => a.status === "launched") ??
    present.find((a) => a.from === "analysis") ??
    present[0] ??
    null
  );
}

/** The analysis read aloud (Phase 54). */
export interface NewsAudio {
  url: string;
  /** About how long it plays. */
  seconds: number;
  /** Phase 61: which service read it (absent on audios from before). */
  voice?: "elevenlabs" | "polly";
  /** Why ElevenLabs didn't read it, when Polly did. */
  note?: string;
}

/**
 * "Refresh news" (`POST /news/refresh`) starts a new analysis at once, but
 * not more often than this for members (admins aren't held to it): every
 * click is a model run, and an analysis takes about half a minute.
 */
export const NEWS_REFRESH_COOLDOWN_SECONDS = 60;

/** `POST /news/refresh`: a new analysis was started, or one was started too recently. */
export interface NewsRefreshResponse {
  queued: boolean;
  /** When `queued` is false: how long until the next one may be started. */
  retryAfterSeconds?: number;
}

/** `GET /news/insights`: the latest analysis, or `null` before the first one. */
export interface NewsInsightsResponse {
  insights: NewsInsights | null;
  /**
   * Phase 49b: the last run that failed, if it's newer than `insights`: the
   * page waiting for an analysis stops at once and says why.
   */
  failure?: NewsInsightsFailure;
  /**
   * Phase 55: the analysis has no audio yet and it is being made right now
   * (a minute at most): ask again in a moment.
   */
  audioPending?: boolean;
}

export interface NewsInsightsFailure {
  /** What went wrong, in a sentence. */
  error: string;
  /** When (epoch ms). */
  at: number;
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

// ---------------------------------------------------------------------------
// "Pregunta a la IA" (Phase 50): questions about the day's news, answered by
// Claude Haiku 5.5 from the stories and the morning's analysis. The chat is
// kept in the page (this tab), never stored: each question sends the turns
// before it.
// ---------------------------------------------------------------------------

/** The longest question, and the longest earlier turn sent back as context. */
export const MAX_NEWS_QUESTION_LENGTH = 1_000;
export const MAX_NEWS_CHAT_TURN_LENGTH = 4_000;
/** How many earlier turns (questions and answers) go with a question. */
export const MAX_NEWS_CHAT_HISTORY = 10;

export const NewsChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_NEWS_CHAT_TURN_LENGTH),
});
export type NewsChatTurn = z.infer<typeof NewsChatTurnSchema>;

export const AskNewsSchema = z.object({
  question: z.string().trim().min(1).max(MAX_NEWS_QUESTION_LENGTH),
  history: z.array(NewsChatTurnSchema).max(MAX_NEWS_CHAT_HISTORY).default([]),
});
export type AskNewsInput = z.input<typeof AskNewsSchema>;

/** A story an answer cites (`[3]` in its text), as the feed has it. */
export interface NewsCitation {
  n: number;
  title: string;
  link: string;
  sourceName: string;
}

/** `POST /news/ask`. */
export interface AskNewsResponse {
  /** Markdown; stories are cited as `[n]`, each listed in `sources`. */
  answer: string;
  sources: NewsCitation[];
}
