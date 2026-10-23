import { z } from "zod";
import { addDays, DATE_RE, dayOfWeek, daysBetween, isDateString } from "./dates";

// ---------------------------------------------------------------------------
// Recurring meetings (Phase 34): a series is one meeting row with a rule.
// The row's own span is the first meeting; the rule says on which later
// dates (company timezone) it happens again, at the same time of day and for
// as long. Occurrences are never stored: the server and the web app expand
// the rule with the functions below, so they always agree. A V1 subset of
// iCalendar's RRULE: daily, weekly (on chosen weekdays) or monthly (on the
// first meeting's day of the month), every N, ending never, on a date or
// after N meetings, plus cancelled dates (`exceptions`).
// ---------------------------------------------------------------------------

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export interface Recurrence {
  freq: RecurrenceFrequency;
  /** Every `interval` days, weeks or months (1 = every one). */
  interval: number;
  /** Weekly only: the days it happens on, 0 = Sunday … 6 = Saturday, sorted. */
  byWeekday?: number[];
  /** The last date it may happen on (inclusive). Not with `count`. */
  until?: string;
  /** How many meetings in all, the first included. Not with `until`. */
  count?: number;
}

export const MAX_RECURRENCE_INTERVAL = 30;
export const MAX_RECURRENCE_COUNT = 365;
/** `until` at most this many days after the first meeting (ten years). */
export const MAX_RECURRENCE_DAYS = 3660;
/** Cancelled dates one series may hold. */
export const MAX_RECURRENCE_EXCEPTIONS = 500;
/** Safety net for the walk over candidate dates. */
const MAX_STEPS = 20_000;

const dateString = z
  .string()
  .regex(DATE_RE, "expected YYYY-MM-DD")
  .refine(isDateString, "not a valid date");

export const RecurrenceSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL).default(1),
    byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    until: dateString.optional(),
    count: z.number().int().min(2).max(MAX_RECURRENCE_COUNT).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.freq === "weekly" && !v.byWeekday) {
      ctx.addIssue({ code: "custom", path: ["byWeekday"], message: "pick the days of the week" });
    }
    if (v.freq !== "weekly" && v.byWeekday) {
      ctx.addIssue({
        code: "custom",
        path: ["byWeekday"],
        message: "days of the week are for weekly meetings",
      });
    }
    if (v.until !== undefined && v.count !== undefined) {
      ctx.addIssue({ code: "custom", path: ["count"], message: "end on a date or after a count" });
    }
  })
  .transform((v) => normalizeRecurrence(v));

export const ExceptionsSchema = z.array(dateString).max(MAX_RECURRENCE_EXCEPTIONS);

/** The canonical form: sorted weekdays, no empty fields. */
export function normalizeRecurrence(rule: Recurrence): Recurrence {
  const out: Recurrence = { freq: rule.freq, interval: rule.interval || 1 };
  if (rule.freq === "weekly" && rule.byWeekday) {
    out.byWeekday = [...new Set(rule.byWeekday)].sort((a, b) => a - b);
  }
  if (rule.until !== undefined) out.until = rule.until;
  else if (rule.count !== undefined) out.count = rule.count;
  return out;
}

/**
 * Why `rule` can't start on `first` (the date of the first meeting), or
 * `null`: the first meeting must be one of the series' own dates, and an end
 * date can't come before it or too far after.
 */
export function recurrenceProblem(rule: Recurrence, first: string): string | null {
  if (rule.freq === "weekly" && !rule.byWeekday?.includes(dayOfWeek(first))) {
    return "a weekly meeting must repeat on the weekday of its first date";
  }
  if (rule.until !== undefined) {
    if (rule.until < first) return "the series can't end before its first meeting";
    if (daysBetween(first, rule.until) > MAX_RECURRENCE_DAYS) {
      return "a series can be planned at most ten years ahead";
    }
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Day `day` of the month `months` after `first`'s month, or `null` when it has no such day. */
function monthDate(first: string, months: number, day: number): string | null {
  const [y, m] = first.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > last ? null : `${year}-${pad(month)}-${pad(day)}`;
}

const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
};

/**
 * Every date of the series in order from `first` (cancelled ones included:
 * they still count towards `count`, as in iCalendar), up to `until`/`count`
 * or forever. With `from` and no `count`, starts near `from` instead of
 * walking from the beginning.
 */
function* seriesDates(first: string, rule: Recurrence, from?: string): Generator<string> {
  const interval = Math.max(1, rule.interval);
  const skip = from !== undefined && rule.count === undefined && from > first;
  let produced = 0;
  const done = (date: string) =>
    (rule.until !== undefined && date > rule.until) ||
    (rule.count !== undefined && produced >= rule.count);

  if (rule.freq === "daily") {
    const k0 = skip ? Math.floor(daysBetween(first, from) / interval) : 0;
    for (let k = k0, steps = 0; steps < MAX_STEPS; k++, steps++) {
      const date = addDays(first, k * interval);
      if (done(date)) return;
      produced++;
      yield date;
    }
    return;
  }

  if (rule.freq === "weekly") {
    const days = rule.byWeekday?.length ? rule.byWeekday : [dayOfWeek(first)];
    const weekStart = addDays(first, -dayOfWeek(first)); // the Sunday of the first week
    const w0 = skip ? Math.floor(daysBetween(weekStart, from) / (7 * interval)) : 0;
    for (let w = w0, steps = 0; steps < MAX_STEPS; w++, steps++) {
      const base = addDays(weekStart, w * 7 * interval);
      for (const wd of days) {
        const date = addDays(base, wd);
        if (date < first) continue;
        if (done(date)) return;
        produced++;
        yield date;
      }
    }
    return;
  }

  const day = Number(first.slice(8, 10));
  const k0 = skip ? Math.floor(monthsBetween(first, from) / interval) : 0;
  for (let k = k0, steps = 0; steps < MAX_STEPS; k++, steps++) {
    const date = monthDate(first, k * interval, day);
    if (date === null) continue; // the 31st of a 30-day month: skipped, like iCalendar
    if (done(date)) return;
    produced++;
    yield date;
  }
}

/**
 * The series' dates within `from`..`to` (inclusive), cancelled ones
 * (`exceptions`) left out.
 */
export function occurrenceDates(
  first: string,
  rule: Recurrence,
  from: string,
  to: string,
  exceptions: Iterable<string> = [],
): string[] {
  const cancelled = new Set(exceptions);
  const out: string[] = [];
  for (const date of seriesDates(first, rule, from)) {
    if (date > to) break;
    if (date >= from && !cancelled.has(date)) out.push(date);
  }
  return out;
}

/** Whether `date` is one of the series' dates (cancelled or not). */
export function isSeriesDate(first: string, rule: Recurrence, date: string): boolean {
  for (const d of seriesDates(first, rule, date)) {
    if (d === date) return true;
    if (d > date) return false;
  }
  return false;
}

/**
 * The series' last date, or `null` when it never ends. With `until` that's
 * an upper bound (the last date on or before it may come earlier).
 */
export function lastSeriesDate(first: string, rule: Recurrence): string | null {
  if (rule.until !== undefined) return rule.until;
  if (rule.count === undefined) return null;
  let last = first;
  for (const date of seriesDates(first, rule)) last = date;
  return last;
}

/**
 * The first date of the series on or after `from` that isn't cancelled, or
 * `null` when the series is over by then.
 */
export function nextSeriesDate(
  first: string,
  rule: Recurrence,
  from: string,
  exceptions: Iterable<string> = [],
): string | null {
  const cancelled = new Set(exceptions);
  let steps = 0;
  for (const date of seriesDates(first, rule, from)) {
    if (++steps > MAX_STEPS) return null;
    if (date >= from && !cancelled.has(date)) return date;
  }
  return null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const ordinal = (n: number) => {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

const untilFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * "Weekly on Monday", "Every weekday", "Every 2 weeks on Mon, Thu",
 * "Monthly on the 15th, 10 times", "Daily, until Dec 18, 2026".
 */
export function describeRecurrence(rule: Recurrence, first: string): string {
  const n = rule.interval;
  let text: string;
  if (rule.freq === "daily") {
    text = n === 1 ? "Daily" : `Every ${n} days`;
  } else if (rule.freq === "weekly") {
    const days = rule.byWeekday?.length ? rule.byWeekday : [dayOfWeek(first)];
    if (n === 1 && days.join() === "1,2,3,4,5") {
      text = "Every weekday";
    } else {
      const names =
        days.length === 1 ? WEEKDAYS[days[0]!] : days.map((d) => SHORT_WEEKDAYS[d]).join(", ");
      text = n === 1 ? `Weekly on ${names}` : `Every ${n} weeks on ${names}`;
    }
  } else {
    const day = ordinal(Number(first.slice(8, 10)));
    text = n === 1 ? `Monthly on the ${day}` : `Every ${n} months on the ${day}`;
  }
  if (rule.count !== undefined) return `${text}, ${rule.count} times`;
  if (rule.until !== undefined) {
    const [y, m, d] = rule.until.split("-").map(Number) as [number, number, number];
    return `${text}, until ${untilFmt.format(Date.UTC(y, m - 1, d))}`;
  }
  return text;
}
