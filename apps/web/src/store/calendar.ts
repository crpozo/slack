import {
  addDays,
  canSeeEvent,
  expandEvents,
  dateInZone,
  yearOf,
  type CalendarEvent,
  type CalendarPushEvent,
  type CreateEventInput,
  type UpdateEventInput,
  type VacationBalance,
  type VacationDecisionInput,
} from "@mindfultech/shared";
import { create } from "zustand";
import { calendarApi, type CalendarApi } from "../lib/calendarApi";

/**
 * Calendar state: the events of the ranges viewed so far (by id, so a push
 * about one is applied once), my vacation balance for the year on screen and,
 * for admins, everyone's. Mutations wait for the server (dates and the ledger
 * are too easy to get wrong optimistically); pushes from other people arrive
 * over the WebSocket as `calendar.*` and are merged by `applyEvent`.
 */
export interface CalendarState {
  events: Record<string, CalendarEvent>;
  /** `from..to` ranges already fetched (inclusive dates), newest last. */
  loadedRanges: Array<{ from: string; to: string }>;
  loading: boolean;
  /** The year the balances are for. */
  year: string;
  mine: VacationBalance | null;
  /** Everyone's balances (admins only); empty otherwise. */
  balances: VacationBalance[];
  error: string | null;

  /** Events overlapping `from`..`to`; fetched once per range (a push keeps it fresh). */
  loadRange: (from: string, to: string) => Promise<void>;
  loadBalances: (year?: string) => Promise<void>;
  createEvent: (input: CreateEventInput) => Promise<CalendarEvent>;
  updateEvent: (eventId: string, patch: UpdateEventInput) => Promise<CalendarEvent>;
  deleteEvent: (eventId: string) => Promise<void>;
  /** Cancels one meeting of a series (Phase 34). */
  cancelOccurrence: (eventId: string, date: string) => Promise<void>;
  decideVacation: (eventId: string, decision: VacationDecisionInput) => Promise<void>;
  setAllowance: (userId: string, year: string, allowance: number) => Promise<void>;
  /** A `calendar.*` push: applied idempotently, hiding what `me` may no longer see. */
  applyEvent: (push: CalendarPushEvent, me: { userId: string; role?: string }) => void;
  clearError: () => void;
  /** Forgets everything (sign-out). */
  reset: () => void;
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

const covered = (ranges: Array<{ from: string; to: string }>, from: string, to: string) =>
  ranges.some((r) => r.from <= from && r.to >= to);

export const thisYear = () => yearOf(dateInZone(Date.now()));

const withEvent = (events: Record<string, CalendarEvent>, event: CalendarEvent) => ({
  ...events,
  [event.eventId]: event,
});
const without = (events: Record<string, CalendarEvent>, eventId: string) => {
  if (!(eventId in events)) return events;
  const next = { ...events };
  delete next[eventId];
  return next;
};

/** Apply a server reply about one event (the store's own writes). */
function merge(
  set: (fn: (s: CalendarState) => Partial<CalendarState>) => void,
  event: CalendarEvent,
) {
  set((s) => ({ events: withEvent(s.events, event) }));
}

export function createCalendarStore(api: CalendarApi) {
  return create<CalendarState>((set, get) => ({
    events: {},
    loadedRanges: [],
    loading: false,
    year: thisYear(),
    mine: null,
    balances: [],
    error: null,

    loadRange: async (from, to) => {
      if (covered(get().loadedRanges, from, to)) return;
      set({ loading: true });
      try {
        const list = await api.listEvents(from, to);
        set((s) => {
          const events = { ...s.events };
          for (const e of list) events[e.eventId] = e;
          return { events, loadedRanges: [...s.loadedRanges, { from, to }].slice(-12) };
        });
      } catch (err) {
        set({ error: message(err, "Couldn't load the calendar.") });
      } finally {
        set({ loading: false });
      }
    },

    loadBalances: async (year = get().year) => {
      try {
        const { mine, balances } = await api.listBalances(year);
        set({ year, mine, balances });
      } catch (err) {
        set({ error: message(err, "Couldn't load your vacation balance.") });
      }
    },

    createEvent: async (input) => {
      const { event, balance } = await api.createEvent(input);
      merge(set, event);
      if (balance && balance.year === get().year) set({ mine: balance });
      return event;
    },

    updateEvent: async (eventId, patch) => {
      const event = await api.updateEvent(eventId, patch);
      merge(set, event);
      return event;
    },

    deleteEvent: async (eventId) => {
      const gone = get().events[eventId];
      await api.deleteEvent(eventId);
      set((s) => ({ events: without(s.events, eventId) }));
      // A cancelled request gives its days back: refresh the ledger.
      if (gone?.type === "vacation") void get().loadBalances();
    },

    cancelOccurrence: async (eventId, date) => {
      merge(set, await api.cancelOccurrence(eventId, date));
    },

    decideVacation: async (eventId, decision) => {
      const event = await api.decideVacation(eventId, decision);
      merge(set, event);
      void get().loadBalances();
    },

    setAllowance: async (userId, year, allowance) => {
      const balance = await api.setAllowance(userId, year, allowance);
      set((s) => ({
        mine: s.mine?.userId === userId && s.year === year ? balance : s.mine,
        balances: s.balances.some((b) => b.userId === userId)
          ? s.balances.map((b) => (b.userId === userId ? balance : b))
          : [...s.balances, balance],
      }));
    },

    applyEvent: (push, me) => {
      set((s) => {
        if (push.type === "calendar.event_deleted") {
          const gone = s.events[push.eventId];
          if (gone?.type === "vacation") void get().loadBalances();
          return { events: without(s.events, push.eventId) };
        }
        const { event } = push;
        if (!canSeeEvent(event, me)) return { events: without(s.events, event.eventId) };
        if (event.type === "vacation" && push.by !== me.userId) void get().loadBalances();
        return { events: withEvent(s.events, event) };
      });
    },

    clearError: () => set({ error: null }),
    reset: () =>
      set({
        events: {},
        loadedRanges: [],
        loading: false,
        year: thisYear(),
        mine: null,
        balances: [],
        error: null,
      }),
  }));
}

export const useCalendar = createCalendarStore(calendarApi);

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of a Date in the browser's timezone (FullCalendar's `local` dates). */
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The inclusive date range FullCalendar shows (its `end` is exclusive). */
export function visibleRange(view: { start: Date; end: Date }): { from: string; to: string } {
  return { from: localDate(view.start), to: addDays(localDate(view.end), -1) };
}

/**
 * Events to draw: everything but rejected requests, which live in the
 * requests list only, with each series expanded into its meetings within
 * `range` (Phase 34: what's been loaded, so every drawn day has them).
 */
export function drawableEvents(
  events: Record<string, CalendarEvent>,
  range: { from: string; to: string } | null = null,
): CalendarEvent[] {
  const drawn = Object.values(events).filter(
    (e) => e.type !== "vacation" || e.status !== "rejected",
  );
  if (!range) return drawn.filter((e) => e.type !== "meeting" || !e.recurrence);
  return expandEvents(drawn, range.from, range.to);
}

/** The span of everything loaded so far (inclusive dates), or `null` before the first load. */
export function loadedSpan(
  ranges: Array<{ from: string; to: string }>,
): { from: string; to: string } | null {
  if (ranges.length === 0) return null;
  return {
    from: ranges.reduce((min, r) => (r.from < min ? r.from : min), ranges[0]!.from),
    to: ranges.reduce((max, r) => (r.to > max ? r.to : max), ranges[0]!.to),
  };
}
