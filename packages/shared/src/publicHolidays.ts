import { addDays, dayOfWeek, zonedMidnight } from "./dates";
import type { HolidayEvent } from "./calendar";

// ---------------------------------------------------------------------------
// Public holidays the calendar knows without anyone typing them (Phase 62):
// Ecuador's national holidays (the company's: they aren't charged to a
// vacation) and the United States' federal ones (where clients are: shown,
// never charged). Computed from the rules, so every year is there. A
// government decree that moves one for a given year isn't known here: an
// admin adds that day as a holiday of their own.
// ---------------------------------------------------------------------------

export type HolidayCountry = "EC" | "US";

export interface PublicHoliday {
  /** `YYYY-MM-DD`: the day off (Ecuador's are already moved as its law says). */
  date: string;
  name: string;
  country: HolidayCountry;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** Easter Sunday (Gregorian; the anonymous algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/**
 * Ecuador moves a holiday to make a long weekend (Ley de Feriados, 2016):
 * Tuesday → the Monday before; Wednesday or Thursday → that Friday;
 * Saturday → the Friday before; Sunday → the Monday after.
 * `weekendOnly`: 1 January and 25 December move only off a weekend.
 */
function observedInEcuador(date: string, weekendOnly = false): string {
  const day = dayOfWeek(date); // 0 Sunday … 6 Saturday
  if (day === 6) return addDays(date, -1);
  if (day === 0) return addDays(date, 1);
  if (weekendOnly) return date;
  if (day === 2) return addDays(date, -1);
  if (day === 3) return addDays(date, 2);
  if (day === 4) return addDays(date, 1);
  return date;
}

/** 2 and 3 November are taken together, so the two days off stay side by side. */
function difuntosAndCuenca(year: number): [string, string] {
  const second = ymd(year, 11, 2);
  const third = ymd(year, 11, 3);
  switch (dayOfWeek(second)) {
    case 2: // Tuesday, Wednesday → Monday, Tuesday
      return [addDays(second, -1), addDays(third, -1)];
    case 3: // Wednesday, Thursday → Thursday, Friday
      return [addDays(second, 1), addDays(third, 1)];
    case 5: // Friday, Saturday → Thursday, Friday
      return [addDays(second, -1), addDays(third, -1)];
    case 6: // Saturday, Sunday → Friday, Monday
      return [addDays(second, -1), addDays(third, 1)];
    case 0: // Sunday, Monday → Monday, Tuesday
      return [addDays(second, 1), addDays(third, 1)];
    default: // Monday–Tuesday, Thursday–Friday: as they fall
      return [second, third];
  }
}

/** Ecuador's national holidays of `year`, and Loja's local ones, on the day off. */
export function ecuadorHolidays(year: number): PublicHoliday[] {
  const easter = easterSunday(year);
  const [difuntos, cuenca] = difuntosAndCuenca(year);
  const list: Array<[string, string]> = [
    [observedInEcuador(ymd(year, 1, 1), true), "Año Nuevo"],
    [addDays(easter, -48), "Carnaval"],
    [addDays(easter, -47), "Carnaval"],
    [addDays(easter, -2), "Viernes Santo"],
    [observedInEcuador(ymd(year, 5, 1)), "Día del Trabajo"],
    [observedInEcuador(ymd(year, 5, 24)), "Batalla de Pichincha"],
    [observedInEcuador(ymd(year, 8, 10)), "Primer Grito de Independencia"],
    [observedInEcuador(ymd(year, 10, 9)), "Independencia de Guayaquil"],
    [difuntos, "Día de los Difuntos"],
    [cuenca, "Independencia de Cuenca"],
    // Loja's own (where the company is): moved like the national ones.
    [observedInEcuador(ymd(year, 11, 18)), "Independencia de Loja"],
    [observedInEcuador(ymd(year, 12, 8)), "Fundación de Loja"],
    [observedInEcuador(ymd(year, 12, 25), true), "Navidad"],
  ];
  return list.map(([date, name]) => ({ date, name, country: "EC" as const }));
}

/** The `n`th `weekday` (0 Sunday … 6 Saturday) of a month; `n = -1` is the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = ymd(year, month, 1);
    const offset = (weekday - dayOfWeek(first) + 7) % 7;
    return addDays(first, offset + 7 * (n - 1));
  }
  const last = addDays(month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1), -1);
  return addDays(last, -((dayOfWeek(last) - weekday + 7) % 7));
}

/** The United States' federal holidays of `year`, on their own date. */
export function usHolidays(year: number): PublicHoliday[] {
  const list: Array<[string, string]> = [
    [ymd(year, 1, 1), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day"],
    [nthWeekday(year, 2, 1, 3), "Presidents' Day"],
    [nthWeekday(year, 5, 1, -1), "Memorial Day"],
    [ymd(year, 6, 19), "Juneteenth"],
    [ymd(year, 7, 4), "Independence Day"],
    [nthWeekday(year, 9, 1, 1), "Labor Day"],
    [nthWeekday(year, 10, 1, 2), "Columbus Day"],
    [ymd(year, 11, 11), "Veterans Day"],
    [nthWeekday(year, 11, 4, 4), "Thanksgiving"],
    [ymd(year, 12, 25), "Christmas Day"],
  ];
  return list.map(([date, name]) => ({ date, name, country: "US" as const }));
}

/** Both countries' holidays from `from` to `to` (inclusive `YYYY-MM-DD`), in date order. */
export function publicHolidaysBetween(from: string, to: string): PublicHoliday[] {
  const out: PublicHoliday[] = [];
  // A year's first holiday can be moved into the year before (1 January on a Saturday).
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)) + 1; year++) {
    for (const h of [...ecuadorHolidays(year), ...usHolidays(year)]) {
      if (h.date >= from && h.date <= to) out.push(h);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.country.localeCompare(b.country));
}

/** Ecuador's holiday dates from `from` to `to`: the days a vacation isn't charged for. */
export function ecuadorHolidayDates(from: string, to: string): Set<string> {
  return new Set(
    publicHolidaysBetween(from, to)
      .filter((h) => h.country === "EC")
      .map((h) => h.date),
  );
}

export const PUBLIC_HOLIDAY_PREFIX = "public-holiday:";
export const HOLIDAY_FLAG: Record<HolidayCountry, string> = { EC: "🇪🇨", US: "🇺🇸" };

/** Whether `eventId` is one of the built-in holidays (nobody's to edit), and whose. */
export function publicHolidayCountry(eventId: string): HolidayCountry | null {
  if (!eventId.startsWith(PUBLIC_HOLIDAY_PREFIX)) return null;
  return eventId.slice(PUBLIC_HOLIDAY_PREFIX.length).startsWith("US") ? "US" : "EC";
}

/** A built-in holiday as a calendar event, so every view draws it like the others. */
export function publicHolidayEvent(holiday: PublicHoliday): HolidayEvent {
  const startAt = zonedMidnight(holiday.date);
  return {
    eventId: `${PUBLIC_HOLIDAY_PREFIX}${holiday.country}:${holiday.date}:${holiday.name}`,
    type: "holiday",
    title: `${HOLIDAY_FLAG[holiday.country]} ${holiday.name}`,
    description: "",
    allDay: true,
    startDate: holiday.date,
    endDate: holiday.date,
    startAt,
    endAt: zonedMidnight(addDays(holiday.date, 1)),
    createdBy: "system",
    createdAt: 0,
    updatedAt: 0,
  };
}
