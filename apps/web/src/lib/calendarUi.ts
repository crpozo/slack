import {
  addDays,
  dateInZone,
  eachDate,
  occurrenceKey,
  vacationOwner,
  type CalendarEvent,
  type VacationStatus,
} from "@mindfultech/shared";

/** What FullCalendar needs to draw one of our events. */
export interface CalendarEventInput {
  id: string;
  title: string;
  allDay: boolean;
  /** `YYYY-MM-DD` for all-day events (no timezone shift), a Date for timed ones. */
  start: string | Date;
  /** Exclusive end, as FullCalendar expects. */
  end: string | Date;
  classNames: string[];
  /** Holidays first in the all-day row, then vacations, then meetings. */
  rank: number;
  extendedProps: { event: CalendarEvent };
}

export const VACATION_STATUS_LABEL: Record<VacationStatus, string> = {
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
};

/** The event's label on the calendar; vacations are named after the person, series get a ↻. */
export function eventLabel(event: CalendarEvent, nameOf: (userId: string) => string): string {
  if (event.type === "meeting" && event.recurrence) return `↻ ${event.title}`;
  if (event.type !== "vacation") return event.title;
  const who = nameOf(vacationOwner(event));
  return event.status === "pending" ? `${who} · Vacation (pending)` : `${who} · Vacation`;
}

export function toCalendarInput(
  event: CalendarEvent,
  nameOf: (userId: string) => string,
): CalendarEventInput {
  // A series' meetings each get their own id (`<eventId>@<date>`).
  const base = {
    id: occurrenceKey(event),
    title: eventLabel(event, nameOf),
    extendedProps: { event },
  };
  const series = event.type === "meeting" && event.recurrence ? ["ev-series"] : [];
  if (event.type === "meeting" && !event.allDay) {
    return {
      ...base,
      allDay: false,
      start: new Date(event.startAt),
      end: new Date(event.endAt),
      classNames: ["ev-meeting", ...series],
      rank: 2,
    };
  }
  // All-day: dates, so a holiday never moves with the browser's timezone.
  const startDate = event.startDate ?? dateInZone(event.startAt);
  const endDate = event.endDate ?? startDate;
  const classNames =
    event.type === "holiday"
      ? ["ev-holiday"]
      : event.type === "vacation"
        ? ["ev-vacation", ...(event.status === "pending" ? ["ev-pending"] : [])]
        : ["ev-meeting", ...series];
  return {
    ...base,
    allDay: true,
    start: startDate,
    end: addDays(endDate, 1),
    classNames,
    rank: event.type === "holiday" ? 0 : event.type === "vacation" ? 1 : 2,
  };
}

/** Dates (`YYYY-MM-DD`) covered by national holidays among `events`. */
export function holidayDates(events: Iterable<CalendarEvent>): Set<string> {
  const dates = new Set<string>();
  for (const e of events) {
    if (e.type !== "holiday") continue;
    for (const d of eachDate(e.startDate, e.endDate)) dates.add(d);
  }
  return dates;
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const dateYearFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Mon, Nov 2" (with the year when it isn't `thisYear`); a date string, never shifted. */
export function formatDate(date: string, thisYear = dateInZone(Date.now()).slice(0, 4)): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = Date.UTC(y, m - 1, d);
  return (String(y) === thisYear ? dateFmt : dateYearFmt).format(at);
}

/** "Mon, Nov 2" or "Mon, Nov 2 – Fri, Nov 6" for an inclusive date range. */
export function formatDateRange(startDate: string, endDate: string): string {
  return startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} – ${formatDate(endDate)}`;
}

/** When an event happens, in the viewer's local time for timed meetings. */
export function formatWhen(event: CalendarEvent): string {
  if (event.type !== "meeting" || event.allDay) {
    const start = event.startDate ?? dateInZone(event.startAt);
    return formatDateRange(start, event.endDate ?? start);
  }
  return `${dateTimeFmt.format(event.startAt)} – ${timeFmt.format(event.endAt)}`;
}

/** Inputs of the meeting form from a timed span (local time). */
export function splitLocal(at: number): { date: string; time: string } {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Epoch ms of a local `YYYY-MM-DD` + `HH:MM` pair, or `null` when either is missing. */
export function joinLocal(date: string, time: string): number | null {
  if (!date || !time) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  const at = new Date(y, m - 1, d, h, min).getTime();
  return Number.isFinite(at) ? at : null;
}

/** "HH:MM" `minutes` after `time` (same day, clamped to 23:59). */
export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
