import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  addDays,
  canSeeEvent,
  dateInZone,
  defaultBalance,
  MAX_EVENT_DAYS,
  seriesEndAt,
  VACATION_DAYS_PER_YEAR,
  yearOf,
  zonedMidnight,
  type CalendarEvent,
  type HolidayEvent,
  type VacationBalance,
  type VacationEvent,
} from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

/**
 * Rows of the `events` table: one per event, keyed by `eventId`, with the
 * year of `startAt` (`year`, company timezone) as the partition key of the
 * `byYear` index so a month's events are one query per year. `participants`
 * is a DynamoDB string set.
 *
 * A recurring meeting (Phase 34) is one row in the `series` partition
 * instead, with `seriesEndAt` (when its last meeting ends, or
 * `Number.MAX_SAFE_INTEGER`): any month's listing also reads the series
 * that started before the month ends and end after it begins, and the
 * clients expand them.
 */
export type EventItem = Omit<CalendarEvent, "participants"> & {
  year: string;
  participants?: Set<string> | string[];
  seriesEndAt?: number;
};

/** The `byYear` partition of recurring meetings. */
export const SERIES_PARTITION = "series";

export function toEvent(item: Record<string, unknown>): CalendarEvent {
  const { participants, ...rest } = item as EventItem;
  delete (rest as { year?: string }).year;
  delete rest.seriesEndAt;
  const list = [...(participants ?? [])].sort((a, b) => a.localeCompare(b));
  const event = { ...rest, description: rest.description ?? "" } as CalendarEvent;
  if (event.type === "holiday") return event;
  return { ...event, participants: list } as CalendarEvent;
}

/** The row for `event`, ready to `Put`. */
export function toItem(event: CalendarEvent): EventItem {
  const { participants, ...rest } = event as CalendarEvent & { participants?: string[] };
  const series = event.type === "meeting" && event.recurrence ? event : null;
  delete (rest as { occurrence?: string }).occurrence; // never stored
  return {
    ...rest,
    year: series ? SERIES_PARTITION : yearOf(startDateOf(event)),
    ...(series && { seriesEndAt: seriesEndAt(series) }),
    ...(participants && participants.length > 0 && { participants: new Set(participants) }),
  };
}

/** The date (company timezone) an event starts on. */
export function startDateOf(event: Pick<CalendarEvent, "startAt"> & { startDate?: string }) {
  // Timed events: the calendar date of the instant, in the company timezone.
  return event.startDate ?? dateInZone(event.startAt);
}

/** Years a `from`..`to` listing must query: an event may have started up to `MAX_EVENT_DAYS` earlier. */
export function yearsCovering(from: string, to: string): string[] {
  const first = Number(yearOf(addDays(from, -MAX_EVENT_DAYS)));
  const last = Number(yearOf(to));
  const years: string[] = [];
  for (let y = first; y <= last; y++) years.push(String(y));
  return years;
}

/**
 * Every event overlapping the inclusive date range `from`..`to` (company
 * timezone), any type, any visibility. Callers filter with `canSeeEvent`.
 * A recurring meeting comes back once, as its series row, when any of its
 * meetings may fall in the range (`occurrencesOf` says which).
 */
export async function eventsBetween(from: string, to: string): Promise<CalendarEvent[]> {
  const fromMs = zonedMidnight(from);
  const toMs = zonedMidnight(addDays(to, 1));
  const pages = await Promise.all([
    ...yearsCovering(from, to).map((year) => queryYear(year, toMs)),
    queryYear(SERIES_PARTITION, toMs, fromMs),
  ]);
  return pages
    .flat()
    .filter((e) => (e.type === "meeting" && e.recurrence ? seriesEndAt(e) : e.endAt) > fromMs)
    .sort((a, b) => a.startAt - b.startAt || a.eventId.localeCompare(b.eventId));
}

async function queryYear(
  year: string,
  before: number,
  /** Series only: skip the ones over before this instant. */
  seriesAfter?: number,
  startKey?: Record<string, unknown>,
): Promise<CalendarEvent[]> {
  const page = await ddb.send(
    new QueryCommand({
      TableName: tables.events,
      IndexName: "byYear",
      KeyConditionExpression: "#year = :year AND startAt < :before",
      ExpressionAttributeNames: { "#year": "year" },
      ExpressionAttributeValues: {
        ":year": year,
        ":before": before,
        ...(seriesAfter !== undefined && { ":after": seriesAfter }),
      },
      ...(seriesAfter !== undefined && { FilterExpression: "seriesEndAt > :after" }),
      ExclusiveStartKey: startKey,
    }),
  );
  const items = (page.Items ?? [])
    .map(toEvent)
    // The series partition holds recurring meetings only.
    .filter((e) => seriesAfter === undefined || (e.type === "meeting" && !!e.recurrence));
  if (!page.LastEvaluatedKey) return items;
  return [...items, ...(await queryYear(year, before, seriesAfter, page.LastEvaluatedKey))];
}

/** Dates of national holidays within `from`..`to`, for charging vacations. */
export async function holidayDatesBetween(from: string, to: string): Promise<Set<string>> {
  const dates = new Set<string>();
  for (const event of await eventsBetween(from, to)) {
    if (event.type !== "holiday") continue;
    for (let d = event.startDate; d <= event.endDate; d = addDays(d, 1)) dates.add(d);
  }
  return dates;
}

/** `userId`'s vacation requests (pending or approved) overlapping `from`..`to`. */
export async function vacationsOf(
  userId: string,
  from: string,
  to: string,
): Promise<VacationEvent[]> {
  return (await eventsBetween(from, to)).filter(
    (e): e is VacationEvent =>
      e.type === "vacation" && e.status !== "rejected" && e.participants.includes(userId),
  );
}

export async function getEvent(eventId: string): Promise<CalendarEvent | null> {
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.events, Key: { eventId } }));
  return Item ? toEvent(Item) : null;
}

/** Broadcast filter: whose connections receive pushes about `event`. */
export function eventAudience(event: CalendarEvent) {
  return (connection: { userId: string; role?: string }) => canSeeEvent(event, connection);
}

export const isHoliday = (e: CalendarEvent): e is HolidayEvent => e.type === "holiday";

// --- The ledger -------------------------------------------------------------------

export function toBalance(item: Record<string, unknown>): VacationBalance {
  return {
    userId: String(item.userId),
    year: String(item.year),
    allowance: typeof item.allowance === "number" ? item.allowance : VACATION_DAYS_PER_YEAR,
    used: typeof item.used === "number" ? item.used : 0,
    pending: typeof item.pending === "number" ? item.pending : 0,
  };
}

export async function getBalance(userId: string, year: string): Promise<VacationBalance> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.vacationBalances, Key: { userId, year } }),
  );
  return Item ? toBalance(Item) : defaultBalance(userId, year);
}

/**
 * Makes sure `userId` has a ledger row for `year` (the statutory allowance,
 * nothing used), so the request transaction can rely on plain arithmetic in
 * its condition. Losing the race to another request is fine: the row exists.
 */
export async function ensureBalance(userId: string, year: string): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.vacationBalances,
        Item: { ...defaultBalance(userId, year), updatedAt: Date.now() },
        ConditionExpression: "attribute_not_exists(userId)",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

/** Every ledger row of `year` (admins' overview). */
export async function balancesOfYear(year: string): Promise<VacationBalance[]> {
  const rows: VacationBalance[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tables.vacationBalances,
        IndexName: "byYear",
        KeyConditionExpression: "#year = :year",
        ExpressionAttributeNames: { "#year": "year" },
        ExpressionAttributeValues: { ":year": year },
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...(page.Items ?? []).map(toBalance));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return rows.sort((a, b) => a.userId.localeCompare(b.userId));
}
