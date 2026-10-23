import type {
  CalendarEvent,
  CreateEventInput,
  Message,
  UpdateEventInput,
  VacationBalance,
  VacationDecisionInput,
  VacationEvent,
} from "@mindfultech/shared";
import { request } from "./tasksApi";

const id = encodeURIComponent;

/** Company calendar (same HTTP API and auth as the Task Manager). */
export const calendarApi = {
  /** Events the caller may see overlapping `from`..`to` (inclusive `YYYY-MM-DD`). */
  listEvents: (from: string, to: string) =>
    request<{ events: CalendarEvent[] }>(
      "GET",
      `/calendar/events?from=${id(from)}&to=${id(to)}`,
    ).then((r) => r.events),
  /**
   * A meeting (anyone), a vacation request (anyone) or a holiday (admins). A
   * meeting with `channelId` (a DM) also posts a card there: `message`.
   */
  createEvent: (input: CreateEventInput) =>
    request<{ event: CalendarEvent; balance?: VacationBalance; message?: Message }>(
      "POST",
      "/calendar/events",
      input,
    ),
  updateEvent: (eventId: string, patch: UpdateEventInput) =>
    request<{ event: CalendarEvent }>("PUT", `/calendar/events/${id(eventId)}`, patch).then(
      (r) => r.event,
    ),
  /** Deletes a meeting/holiday, or cancels a vacation request (its days go back). */
  deleteEvent: (eventId: string) => request<void>("DELETE", `/calendar/events/${id(eventId)}`),
  /** Cancels the meeting of a series on `date` (Phase 34); the rest of the series stays. */
  cancelOccurrence: (eventId: string, date: string) =>
    request<{ event: CalendarEvent }>(
      "DELETE",
      `/calendar/events/${id(eventId)}?occurrence=${id(date)}`,
    ).then((r) => r.event),
  /** Admin: approve or reject a pending request. */
  decideVacation: (eventId: string, decision: VacationDecisionInput) =>
    request<{ event: VacationEvent }>(
      "PUT",
      `/calendar/vacations/${id(eventId)}/status`,
      decision,
    ).then((r) => r.event),
  /** My balance for `year`; admins also get everyone's. */
  listBalances: (year: string) =>
    request<{ year: string; mine: VacationBalance; balances: VacationBalance[] }>(
      "GET",
      `/calendar/balances?year=${id(year)}`,
    ),
  /** Admin: someone's allowance for a year. */
  setAllowance: (userId: string, year: string, allowance: number) =>
    request<{ balance: VacationBalance }>("PUT", `/calendar/balances/${id(userId)}/${id(year)}`, {
      allowance,
    }).then((r) => r.balance),
};

export type CalendarApi = typeof calendarApi;
