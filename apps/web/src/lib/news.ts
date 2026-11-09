// AI News (Phase 35b): how the view words dates (and, Phase 57, sources). Pure, tested.

import { NEWS_PLATFORM_NAMES, newsSourceBadge } from "@mindfultech/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Just now", "12 min ago", "3 h ago", "2 d ago", then "Oct 20". */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "Just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} d ago`;
  return dateFmt.format(at);
}

/** "Mon, Oct 26, 2026, 9:05 AM" in the viewer's time zone, for tooltips. */
export function fullDate(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  return Number.isFinite(at) ? fullFmt.format(at) : "";
}

/**
 * A story's source as the News view writes it (Phase 57): a publisher by its
 * name ("TechCrunch"); a social account by its short name and platform
 * ("Evolving AI · Instagram"), or `short` just its name, where space is tight.
 */
export function sourceLabel(sourceName: string, { short = false } = {}): string {
  const { label, platform } = newsSourceBadge(sourceName);
  return platform && !short ? `${label} · ${NEWS_PLATFORM_NAMES[platform]}` : label;
}

/** "Leer en TechCrunch", or "Ver en Instagram" for a post. */
export function readOnLabel(sourceName: string): string {
  const { label, platform } = newsSourceBadge(sourceName);
  return platform ? `Ver en ${NEWS_PLATFORM_NAMES[platform]}` : `Leer en ${label}`;
}
