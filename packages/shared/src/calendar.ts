import { z } from "zod";
import { UserIdSchema, type MeetingCard } from "./protocol";

// ---------------------------------------------------------------------------
// Company calendar (Phase 19): meetings between members, vacation requests
// with an admin approval flow and a yearly allowance, and national holidays.
// Served by the HTTP API (API Gateway v2 + Cognito JWT), like the Task Manager.
// ---------------------------------------------------------------------------

export const CALENDAR_EVENT_TYPES = ["meeting", "vacation", "holiday"] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export const VACATION_STATUSES = ["pending", "approved", "rejected"] as const;
export type VacationStatus = (typeof VACATION_STATUSES)[number];

/**
 * All-day events (vacations, holidays) are dates in the company's timezone:
 * a holiday on 2026-08-10 is that whole day in Ecuador, whatever the browser's
 * timezone. Timed meetings are instants (epoch ms) and show in local time.
 */
export const COMPANY_TIMEZONE = "America/Guayaquil";

/** Statutory yearly vacation allowance (days), the default of every ledger row. */
export const VACATION_DAYS_PER_YEAR = 15;
/**
 * How a vacation request is charged to the allowance: working days only
 * (Monday–Friday, skipping national holidays) or every calendar day in the range.
 */
export const VACATION_COUNTS_WORKING_DAYS_ONLY = true;
/** Admins may grant more days (seniority); never fewer than already used. */
export const MAX_VACATION_ALLOWANCE = 60;

/** Longest span of any event; the range query looks back this far for events already running. */
export const MAX_EVENT_DAYS = 31;
/** Widest `from`..`to` a client may ask for in one request (a month view shows up to 42 days). */
export const MAX_LIST_RANGE_DAYS = 100;
export const MAX_EVENT_TITLE_LENGTH = 120;
export const MAX_EVENT_DESCRIPTION_LENGTH = 2000;
export const MAX_EVENT_PARTICIPANTS = 50;
export const MAX_VACATION_NOTE_LENGTH = 500;
/** A timed meeting lasts at least this long and at most a day. */
export const MIN_MEETING_MS = 5 * 60 * 1000;
export const MAX_MEETING_MS = 24 * 60 * 60 * 1000;

/** Event ids are `ev_<ulid>`. */
export const isCalendarEventId = (id: string) => /^ev_[0-9A-Z]{26}$/.test(id);

// --- Dates in the company timezone --------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

/** `[startAt, endAt)` in epoch ms of the inclusive date range, in the company timezone. */
export function allDaySpan(startDate: string, endDate: string): { startAt: number; endAt: number } {
  return { startAt: zonedMidnight(startDate), endAt: zonedMidnight(addDays(endDate, 1)) };
}

// --- The vacation ledger ----------------------------------------------------------

/**
 * How many allowance days a vacation from `startDate` to `endDate` (inclusive)
 * costs: with `VACATION_COUNTS_WORKING_DAYS_ONLY`, Monday–Friday days that
 * aren't in `holidays` (dates of national holidays); otherwise every day.
 */
export function countVacationDays(
  startDate: string,
  endDate: string,
  holidays: ReadonlySet<string> = new Set(),
): number {
  let days = 0;
  for (const date of eachDate(startDate, endDate)) {
    if (VACATION_COUNTS_WORKING_DAYS_ONLY && (isWeekend(date) || holidays.has(date))) continue;
    days++;
  }
  return days;
}

export interface VacationBalance {
  userId: string;
  /** `YYYY`, the year the vacation starts in. */
  year: string;
  allowance: number;
  /** Days of approved requests. */
  used: number;
  /** Days of requests awaiting a decision (reserved: they count against the allowance). */
  pending: number;
}

export const remainingDays = (b: Pick<VacationBalance, "allowance" | "used" | "pending">) =>
  Math.max(0, b.allowance - b.used - b.pending);

export const defaultBalance = (userId: string, year: string): VacationBalance => ({
  userId,
  year,
  allowance: VACATION_DAYS_PER_YEAR,
  used: 0,
  pending: 0,
});

// --- Events ------------------------------------------------------------------------

interface CalendarEventBase {
  eventId: string;
  title: string;
  description: string;
  /** `[startAt, endAt)` in epoch ms; for all-day events, company-timezone midnights. */
  startAt: number;
  endAt: number;
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export interface MeetingEvent extends CalendarEventBase {
  type: "meeting";
  allDay: boolean;
  /** Inclusive `YYYY-MM-DD` bounds; only on all-day meetings. */
  startDate?: string;
  endDate?: string;
  /** The organizer (`createdBy`) and everyone invited; only they see the meeting. */
  participants: string[];
  /**
   * Scheduled from a direct message (Phase 21): the conversation and the
   * "meeting scheduled" card posted there, so an edit of the meeting rewrites
   * the card in the same transaction (Phase 23.1) and the chat never shows a
   * stale time.
   */
  channelId?: string;
  messageId?: string;
  messageSk?: string;
}

export interface VacationEvent extends CalendarEventBase {
  type: "vacation";
  allDay: true;
  startDate: string;
  endDate: string;
  /** The requester, alone. */
  participants: string[];
  status: VacationStatus;
  /** Allowance days this request costs, fixed when it was made. */
  days: number;
  /** The requester's note to the admins. */
  note: string;
  decidedBy?: string;
  decidedAt?: number;
  decisionNote?: string;
}

export interface HolidayEvent extends CalendarEventBase {
  type: "holiday";
  allDay: true;
  startDate: string;
  endDate: string;
}

export type CalendarEvent = MeetingEvent | VacationEvent | HolidayEvent;

/**
 * Who may see `event`: holidays and approved vacations are company-wide, a
 * pending or rejected vacation is the requester's and the admins' business
 * (the calendar only draws approved and pending ones), and a meeting is its
 * participants'.
 */
export function canSeeEvent(
  event: CalendarEvent,
  viewer: { userId: string; role?: string },
): boolean {
  if (viewer.role === "guest") return false;
  switch (event.type) {
    case "holiday":
      return true;
    case "vacation":
      if (event.status === "approved") return true;
      // Pending or rejected: the requester's and the admins' business.
      return event.participants.includes(viewer.userId) || viewer.role === "admin";
    case "meeting":
      return event.participants.includes(viewer.userId);
  }
}

/** The requester of a vacation request. */
export const vacationOwner = (event: VacationEvent) => event.participants[0] ?? event.createdBy;

/** Whether `a` and `b` share at least one day. */
export const datesOverlap = (
  a: { startDate: string; endDate: string },
  b: { startDate: string; endDate: string },
) => a.startDate <= b.endDate && b.startDate <= a.endDate;

// --- Request schemas -----------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(v), "cannot contain control characters");

export const DateStringSchema = z
  .string()
  .regex(DATE_RE, "expected YYYY-MM-DD")
  .refine(isDateString, "not a valid date");

const title = text(MAX_EVENT_TITLE_LENGTH).pipe(z.string().min(1, "a title is required"));
const description = text(MAX_EVENT_DESCRIPTION_LENGTH).default("");
const epochMs = z.number().int().positive();

/** Inclusive date range of at most `MAX_EVENT_DAYS` days. */
const dateRangeOk = (v: { startDate: string; endDate: string }) =>
  v.endDate >= v.startDate && daysBetween(v.startDate, v.endDate) < MAX_EVENT_DAYS;
const DATE_RANGE_MESSAGE = `the end must be on or after the start, at most ${MAX_EVENT_DAYS} days later`;

/**
 * A meeting: timed (`startAt`/`endAt`) or all-day (`startDate`/`endDate`).
 * The organizer is added to `participants` by the server.
 *
 * With `channelId` (a direct message), the meeting is scheduled from that
 * conversation: the participants are the DM's two people (never taken from
 * the body), it must be timed, and the server also posts a "meeting
 * scheduled" card in the DM, in the same transaction. `clientId` makes a
 * retried request return the pair already created instead of a second one.
 */
export const CreateMeetingSchema = z
  .object({
    type: z.literal("meeting"),
    title,
    description,
    allDay: z.boolean().default(false),
    startAt: epochMs.optional(),
    endAt: epochMs.optional(),
    startDate: DateStringSchema.optional(),
    endDate: DateStringSchema.optional(),
    participants: z.array(UserIdSchema).max(MAX_EVENT_PARTICIPANTS).default([]),
    channelId: z.string().min(1).max(128).optional(),
    clientId: z.string().min(1).max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.channelId !== undefined) {
      if (v.participants.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["participants"],
          message: "a meeting scheduled from a conversation takes its participants from it",
        });
      }
      if (v.allDay) {
        ctx.addIssue({ code: "custom", path: ["allDay"], message: "a DM meeting has a time" });
      }
    }
    if (v.allDay) {
      if (!v.startDate || !v.endDate) {
        ctx.addIssue({ code: "custom", message: "an all-day meeting needs startDate and endDate" });
      } else if (!dateRangeOk({ startDate: v.startDate, endDate: v.endDate })) {
        ctx.addIssue({ code: "custom", path: ["endDate"], message: DATE_RANGE_MESSAGE });
      }
      return;
    }
    if (v.startAt === undefined || v.endAt === undefined) {
      ctx.addIssue({ code: "custom", message: "a meeting needs startAt and endAt" });
      return;
    }
    const length = v.endAt - v.startAt;
    if (length < MIN_MEETING_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "a meeting lasts at least 5 minutes",
      });
    } else if (length > MAX_MEETING_MS) {
      ctx.addIssue({ code: "custom", path: ["endAt"], message: "a meeting lasts at most a day" });
    }
  });

/** A vacation request (the caller's own); charged to the year of `startDate`. */
export const CreateVacationSchema = z
  .object({
    type: z.literal("vacation"),
    startDate: DateStringSchema,
    endDate: DateStringSchema,
    note: text(MAX_VACATION_NOTE_LENGTH).default(""),
  })
  .refine(dateRangeOk, { path: ["endDate"], message: DATE_RANGE_MESSAGE });

/** A national holiday (admins only): one day, or a range (`endDate` defaults to `startDate`). */
export const CreateHolidaySchema = z
  .object({
    type: z.literal("holiday"),
    title,
    description,
    startDate: DateStringSchema,
    endDate: DateStringSchema.optional(),
  })
  .refine((v) => v.endDate === undefined || dateRangeOk({ ...v, endDate: v.endDate }), {
    path: ["endDate"],
    message: DATE_RANGE_MESSAGE,
  });

export const CreateEventSchema = z.discriminatedUnion("type", [
  CreateMeetingSchema,
  CreateVacationSchema,
  CreateHolidaySchema,
]);

/**
 * Edits a meeting (organizer) or a holiday (admin): any of the fields, at
 * least one. A vacation can't be edited: cancel it and request again.
 */
export const UpdateEventSchema = z
  .object({
    title: title.optional(),
    description: text(MAX_EVENT_DESCRIPTION_LENGTH).optional(),
    allDay: z.boolean().optional(),
    startAt: epochMs.optional(),
    endAt: epochMs.optional(),
    startDate: DateStringSchema.optional(),
    endDate: DateStringSchema.optional(),
    participants: z.array(UserIdSchema).max(MAX_EVENT_PARTICIPANTS).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "nothing to update");

export const VacationDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  note: text(MAX_VACATION_NOTE_LENGTH).default(""),
});

export const UpdateBalanceSchema = z.object({
  allowance: z.number().int().min(0).max(MAX_VACATION_ALLOWANCE),
});

/** `GET /calendar/events?from=&to=`: inclusive dates, at most `MAX_LIST_RANGE_DAYS` apart. */
export const ListEventsQuerySchema = z
  .object({ from: DateStringSchema, to: DateStringSchema })
  .refine((v) => v.to >= v.from && daysBetween(v.from, v.to) < MAX_LIST_RANGE_DAYS, {
    message: `to must be on or after from, at most ${MAX_LIST_RANGE_DAYS} days later`,
  });

export const YearSchema = z.string().regex(/^\d{4}$/, "expected YYYY");

export type CreateMeetingInput = z.input<typeof CreateMeetingSchema>;
export type CreateVacationInput = z.input<typeof CreateVacationSchema>;
export type CreateHolidayInput = z.input<typeof CreateHolidaySchema>;
export type CreateEventInput = z.input<typeof CreateEventSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
export type VacationDecisionInput = z.input<typeof VacationDecisionSchema>;

// --- Real-time pushes (over the chat WebSocket, like `board.*`) --------------------------

export interface CalendarEventCreatedEvent {
  type: "calendar.event_created";
  event: CalendarEvent;
  /** Who did it, for "X invited you" alerts. */
  by: string;
}
export interface CalendarEventUpdatedEvent {
  type: "calendar.event_updated";
  event: CalendarEvent;
  by: string;
  /** Set when an admin decided a vacation request (`event.status` is the outcome). */
  decision?: "approved" | "rejected";
}
export interface CalendarEventDeletedEvent {
  type: "calendar.event_deleted";
  eventId: string;
  by: string;
}
export type CalendarPushEvent =
  CalendarEventCreatedEvent | CalendarEventUpdatedEvent | CalendarEventDeletedEvent;

/** The plain-text fallback of a meeting card (notifications, previews, older clients). */
export function meetingCardText(
  card: Pick<MeetingCard, "title" | "startAt" | "endAt"> &
    Partial<Pick<MeetingCard, "allDay" | "startDate" | "endDate">>,
): string {
  const when = describeEventWhen({ ...card, allDay: card.allDay ?? false });
  return `📅 Meeting scheduled: ${card.title} · ${when}`;
}

/**
 * The card of a meeting as it stands now: what its DM's "meeting scheduled"
 * message shows. The server writes it when the meeting is scheduled and again
 * on every edit; the web app derives it from the live event when it has one.
 */
export function meetingCardOf(event: MeetingEvent): MeetingCard {
  return {
    eventId: event.eventId,
    title: event.title,
    description: event.description,
    allDay: event.allDay,
    startAt: event.startAt,
    endAt: event.endAt,
    participants: event.participants,
    ...(event.allDay && { startDate: event.startDate, endDate: event.endDate }),
  };
}

/** Date and time of an event, for notification text; all-day events show the dates only. */
export function describeEventWhen(
  event: Pick<CalendarEvent, "startAt" | "endAt" | "startDate" | "endDate"> & { allDay: boolean },
  timeZone = COMPANY_TIMEZONE,
): string {
  if (event.allDay && event.startDate) {
    const end = event.endDate ?? event.startDate;
    return end === event.startDate ? event.startDate : `${event.startDate} → ${end}`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return fmt.format(new Date(event.startAt));
}
