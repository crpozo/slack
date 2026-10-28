// AI News dashboard (Phase 41): what the view shows, from the live stories
// and the morning's analysis. Pure, tested.

import {
  NEWS_INSIGHTS_TIME_ZONE,
  NEWS_INSIGHTS_TOP_STORIES,
  type NewsArticle,
  type NewsInsights,
  type NewsStory,
} from "@mindfultech/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A live story in the dashboard's shape (its own title and snippet, untranslated). */
export function storyOf(article: NewsArticle): NewsStory {
  return {
    headline: article.title,
    summary: article.snippet,
    sourceName: article.sourceName,
    link: article.link,
    thumbnailUrl: article.imageUrl,
    pubDate: article.pubDate,
  };
}

/** Same page, whatever the tracking query, `#` or trailing `/`. */
const pageOf = (link: string) => {
  try {
    const url = new URL(link);
    return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return link;
  }
};

/**
 * "Lo esencial" and the rest: the analysis's picks when there is one, else
 * the newest live stories; "Más historias" is every live story not already
 * on top, newest first.
 */
export function dashboardStories(
  insights: Pick<NewsInsights, "stories"> | null,
  articles: NewsArticle[],
): { top: NewsStory[]; more: NewsStory[] } {
  const picked = insights?.stories.length ? insights.stories : articles.map(storyOf);
  const top = picked.slice(0, NEWS_INSIGHTS_TOP_STORIES);
  const onTop = new Set(top.map((s) => pageOf(s.link)));
  const more = articles.filter((a) => !onTop.has(pageOf(a.link))).map(storyOf);
  return { top, more };
}

export interface HighlightPart {
  text: string;
  mark: boolean;
}

/**
 * A trend's text in plain and highlighted parts: `**key phrase**` is marked,
 * everything else is text (never HTML). An unpaired `**` stays as written.
 */
export function highlightParts(text: string): HighlightPart[] {
  const parts: HighlightPart[] = [];
  const pattern = /\*\*([^*]+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), mark: false });
    parts.push({ text: match[1]!, mark: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mark: false });
  return parts;
}

const dayFmt = new Intl.DateTimeFormat("es-EC", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: NEWS_INSIGHTS_TIME_ZONE,
});

/** "Mié 28 oct 2026": the analysis's day, or today, in the team's time zone. */
export function dashboardDateLabel(day: string | null, now = Date.now()): string {
  // Noon UTC: the same calendar day in Ecuador.
  const at = day ? Date.parse(`${day}T12:00:00Z`) : now;
  if (!Number.isFinite(at)) return day ?? "";
  const label = dayFmt
    .formatToParts(at)
    .filter((p) => p.type !== "literal")
    .map((p) => p.value.replace(/\.$/, ""))
    .join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const shortFmt = new Intl.DateTimeFormat("es-EC", { day: "numeric", month: "short" });

/** "hace un momento", "hace 12 min", "hace 3 h", "hace 2 d", then "20 oct". */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "hace un momento";
  if (ago < HOUR) return `hace ${Math.floor(ago / MINUTE)} min`;
  if (ago < DAY) return `hace ${Math.floor(ago / HOUR)} h`;
  if (ago < 7 * DAY) return `hace ${Math.floor(ago / DAY)} d`;
  return shortFmt.format(at).replace(".", "");
}
