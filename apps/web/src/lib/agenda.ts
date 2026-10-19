import { addDays, dateInZone, eachDate, type CalendarEvent } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// The phone calendar: a continuous vertical list of days (like iOS), built
// from the same events the desktop grid shows. Pure helpers, tested.
// ---------------------------------------------------------------------------

/** `YYYY-MM`. */
export type MonthKey = string;

const pad = (n: number) => String(n).padStart(2, "0");

export const monthOf = (date: string): MonthKey => date.slice(0, 7);

/** The month `n` months after `month` (negative goes back). */
export function addMonths(month: MonthKey, n: number): MonthKey {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Every date of `month`, first to last. */
export function monthDays(month: MonthKey): string[] {
  const first = `${month}-01`;
  return eachDate(first, addDays(`${addMonths(month, 1)}-01`, -1));
}

/** `[from, to]` inclusive dates covering `months` (which must be consecutive and sorted). */
export function monthsRange(months: MonthKey[]): { from: string; to: string } {
  const first = months[0]!;
  const last = months[months.length - 1]!;
  return { from: `${first}-01`, to: addDays(`${addMonths(last, 1)}-01`, -1) };
}

const monthFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

/** "October 2026". */
export function monthTitle(month: MonthKey): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return monthFmt.format(Date.UTC(y, m - 1, 1));
}

/** The first date (company timezone) an event covers. */
export const eventStartDate = (e: CalendarEvent) => e.startDate ?? dateInZone(e.startAt);
/** The last date an event covers (inclusive). */
export const eventEndDate = (e: CalendarEvent) =>
  e.endDate ?? e.startDate ?? dateInZone(Math.max(e.startAt, e.endAt - 1));

/**
 * Events keyed by every date they cover, each day's list ordered holidays
 * first, then all-day items, then timed ones by start.
 */
export function eventsByDate(events: Iterable<CalendarEvent>): Map<string, CalendarEvent[]> {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    for (const date of eachDate(eventStartDate(e), eventEndDate(e))) {
      const list = byDate.get(date) ?? [];
      list.push(e);
      byDate.set(date, list);
    }
  }
  const rank = (e: CalendarEvent) =>
    e.type === "holiday" ? 0 : e.type === "vacation" ? 1 : e.allDay ? 2 : 3;
  for (const list of byDate.values()) {
    list.sort(
      (a, b) => rank(a) - rank(b) || a.startAt - b.startAt || a.title.localeCompare(b.title),
    );
  }
  return byDate;
}

/** Minutes before a meeting starts when "Join call" opens. */
export const JOIN_WINDOW_MS = 5 * 60 * 1000;

export type JoinState = "upcoming" | "open" | "over";

/** Whether a meeting can be joined at `now`: from 5 minutes before it starts until it ends. */
export function joinState(meeting: { startAt: number; endAt: number }, now: number): JoinState {
  if (now >= meeting.endAt) return "over";
  if (now >= meeting.startAt - JOIN_WINDOW_MS) return "open";
  return "upcoming";
}
