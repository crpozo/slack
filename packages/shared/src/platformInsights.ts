// ---------------------------------------------------------------------------
// Platform Insights (Phase 64): how the team uses this app, in numbers, and
// what the AI would improve. Only for the owners named in the deployment's
// configuration (an SSM parameter), not a role: an admin doesn't see it.
//
// It works on counts, never on content: who wrote how many messages where and
// when, tasks by state, hours logged. No message text, file, secret or note
// is read. Direct messages count as one group, without naming the pairs.
// ---------------------------------------------------------------------------

/** How far back the numbers go. */
export const PLATFORM_INSIGHTS_DAYS = 30;
/** A report can be asked for again after this long. */
export const PLATFORM_INSIGHTS_COOLDOWN_SECONDS = 60;
/** The page gives up waiting for a report after this long. */
export const PLATFORM_INSIGHTS_WAIT_MS = 3 * 60_000;

export interface InsightsPerson {
  name: string;
  role: string;
  messages: number;
  /** Days with at least one message. */
  activeDays: number;
  /** `YYYY-MM-DD` of the last message in the period, or `null`. */
  lastActive: string | null;
  openTasks: number;
  tasksDone: number;
  hoursLogged: number;
}

export interface InsightsChannel {
  name: string;
  type: string;
  messages: number;
  people: number;
  /** `YYYY-MM-DD` of its last message ever (or `null`: never used). */
  lastMessage: string | null;
  hasExternals: boolean;
}

export interface PlatformMetrics {
  /** `YYYY-MM-DD`..`YYYY-MM-DD`, in the company's timezone. */
  from: string;
  to: string;
  days: number;
  people: { total: number; active: number; guests: number; list: InsightsPerson[] };
  messages: {
    total: number;
    /** The same count over the period before, to compare. */
    previous: number;
    inChannels: number;
    inDirectMessages: number;
    replies: number;
    withFiles: number;
    voice: number;
    /** One entry per day of the period. */
    perDay: Array<{ date: string; count: number }>;
    /** 24 entries, the company's local hours. */
    perHour: number[];
    /** 7 entries, Monday first. */
    perWeekday: number[];
    /** Messages outside 08:00–18:00 on weekdays, or on a weekend. */
    outsideHours: number;
  };
  channels: {
    total: number;
    active: number;
    list: InsightsChannel[];
    /** Channels with no message in the period (names). */
    quiet: string[];
  };
  tasks: {
    boards: number;
    open: number;
    byStatus: Record<string, number>;
    created: number;
    done: number;
    unassigned: number;
    /** Open tasks nobody has touched in 14 days. */
    stale: number;
    /** Median days from creation to done, for those done in the period (`null`: none). */
    medianDaysToDone: number | null;
  };
  calls: { withNotes: number; minutes: number };
  time: {
    hours: number;
    /** With the channels' hourly rates; `null` when none is set. */
    cost: number | null;
    byChannel: Array<{ name: string; hours: number; cost: number | null }>;
  };
}

export interface InsightsRecommendation {
  title: string;
  /** What in the numbers says so. */
  why: string;
  /** What to do, concretely. */
  how: string;
  /** `alto`, `medio` or `bajo`. */
  impact: string;
}

export interface PlatformAnalysis {
  summary: string;
  wins: string[];
  risks: string[];
  recommendations: InsightsRecommendation[];
  /** What the numbers can't answer and is worth asking the team. */
  questions: string[];
}

export interface PlatformReport {
  generatedAt: number;
  metrics: PlatformMetrics;
  /** Absent when the model couldn't write it: the numbers are still shown. */
  analysis?: PlatformAnalysis;
  analysisError?: string;
}

/** `GET /platform-insights/access`: whether this person sees the section at all. */
export interface PlatformInsightsAccess {
  allowed: boolean;
}

/** `GET /platform-insights`. */
export interface PlatformInsightsResponse {
  report: PlatformReport | null;
  /** A report is being written since then (epoch ms). */
  generatingSince?: number;
  /** The last attempt failed. */
  error?: string;
}

/** `POST /platform-insights`. */
export interface PlatformInsightsStarted {
  queued: boolean;
  retryAfterSeconds?: number;
}
