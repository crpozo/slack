// ---------------------------------------------------------------------------
// Dates: `YYYY-MM-DD` strings, pure calendar arithmetic, and instants in the
// company's timezone. Shared by the calendar and recurring meetings.
// ---------------------------------------------------------------------------

/**
 * All-day events (vacations, holidays) are dates in the company's timezone:
 * a holiday on 2026-08-10 is that whole day in Ecuador, whatever the browser's
 * timezone. Timed meetings are instants (epoch ms) and show in local time.
 */
export const COMPANY_TIMEZONE = "America/Guayaquil";

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` that names a real date. */
export function isDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The date `n` days after `date` (negative `n` goes back). Pure calendar arithmetic. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Days from `a` to `b` (`b - a`); negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWeekend = (date: string) => {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
};

export const yearOf = (date: string) => date.slice(0, 4);

/** Every date from `start` to `end`, both inclusive (empty when `end` is earlier). */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(timeZone: string, at: number): Record<string, number> {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(at))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

/** The calendar date of instant `at` (epoch ms) in `timeZone`. */
export function dateInZone(at: number, timeZone = COMPANY_TIMEZONE): string {
  const p = partsIn(timeZone, at);
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}`;
}

/**
 * Epoch ms of midnight at the start of `date` in `timeZone`. Works for any
 * offset (DST included): the guess is UTC midnight, corrected by the zone's
 * offset at that instant, then checked once more.
 */
export function zonedMidnight(date: string, timeZone = COMPANY_TIMEZONE): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(timeZone, guess);
    const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    const offset = asUtc - guess; // what the zone shows minus what UTC is
    guess = Date.UTC(y, m - 1, d) - offset;
    if (offset === 0) break;
  }
  return guess;
}
