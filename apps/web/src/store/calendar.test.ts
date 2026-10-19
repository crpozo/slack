import type { CalendarEvent, VacationBalance, VacationEvent } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import type { CalendarApi } from "../lib/calendarApi";
import { createCalendarStore, drawableEvents, visibleRange } from "./calendar";

const ME = { userId: "me" };
const ADMIN = { userId: "boss", role: "admin" };

const balance = (patch: Partial<VacationBalance> = {}): VacationBalance => ({
  userId: "me",
  year: "2026",
  allowance: 15,
  used: 0,
  pending: 0,
  ...patch,
});
const vacation = (id: string, status: VacationEvent["status"], userId = "me"): VacationEvent => ({
  eventId: id,
  type: "vacation",
  title: "Vacation",
  description: "",
  allDay: true,
  startAt: 1,
  endAt: 2,
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  participants: [userId],
  status,
  days: 5,
  note: "",
  createdBy: userId,
  createdAt: 1,
  updatedAt: 1,
});
const meeting = (id: string, participants: string[]): CalendarEvent => ({
  eventId: id,
  type: "meeting",
  title: "Standup",
  description: "",
  allDay: false,
  startAt: 1,
  endAt: 2,
  participants,
  createdBy: participants[0]!,
  createdAt: 1,
  updatedAt: 1,
});

function fakeApi(overrides: Partial<CalendarApi> = {}): CalendarApi {
  return {
    listEvents: vi.fn(async () => []),
    createEvent: vi.fn(async () => ({ event: meeting("ev_new", ["me"]) })),
    updateEvent: vi.fn(async () => meeting("ev_1", ["me"])),
    deleteEvent: vi.fn(async () => undefined),
    decideVacation: vi.fn(async () => vacation("ev_v", "approved")),
    listBalances: vi.fn(async (year: string) => ({ year, mine: balance({ year }), balances: [] })),
    setAllowance: vi.fn(async (userId, year, allowance) => balance({ userId, year, allowance })),
    ...overrides,
  };
}

describe("calendar store", () => {
  it("loads a range once and keeps events by id", async () => {
    const api = fakeApi({
      listEvents: vi.fn(async () => [meeting("ev_1", ["me"]), vacation("ev_v", "approved", "ana")]),
    });
    const store = createCalendarStore(api);
    await store.getState().loadRange("2026-11-01", "2026-12-06");
    await store.getState().loadRange("2026-11-01", "2026-11-30"); // inside the first: no call
    expect(api.listEvents).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.getState().events).sort()).toEqual(["ev_1", "ev_v"]);
    expect(store.getState().loading).toBe(false);
  });

  it("reports a failed load as an error, once", async () => {
    const store = createCalendarStore(
      fakeApi({ listEvents: vi.fn(async () => Promise.reject(new Error("offline"))) }),
    );
    await store.getState().loadRange("2026-11-01", "2026-12-06");
    expect(store.getState().error).toBe("offline");
    store.getState().clearError();
    expect(store.getState().error).toBeNull();
  });

  it("a vacation request updates my balance from the reply", async () => {
    const api = fakeApi({
      createEvent: vi.fn(async () => ({
        event: vacation("ev_v", "pending"),
        balance: balance({ pending: 5 }),
      })),
    });
    const store = createCalendarStore(api);
    await store.getState().loadBalances("2026");
    await store
      .getState()
      .createEvent({ type: "vacation", startDate: "2026-11-02", endDate: "2026-11-06" });
    expect(store.getState().mine).toEqual(balance({ pending: 5 }));
    expect((store.getState().events.ev_v as VacationEvent | undefined)?.status).toBe("pending");
  });

  it("cancelling or deciding a vacation refreshes the ledger", async () => {
    const api = fakeApi();
    const store = createCalendarStore(api);
    store.setState({ events: { ev_v: vacation("ev_v", "pending") } });
    await store.getState().deleteEvent("ev_v");
    expect(store.getState().events.ev_v).toBeUndefined();
    expect(api.listBalances).toHaveBeenCalledTimes(1);

    store.setState({ events: { ev_v: vacation("ev_v", "pending", "ana") } });
    await store.getState().decideVacation("ev_v", { status: "approved" });
    expect((store.getState().events.ev_v as VacationEvent | undefined)?.status).toBe("approved");
    expect(api.listBalances).toHaveBeenCalledTimes(2);
  });

  it("applies pushes idempotently and drops what I can't see any more", () => {
    const store = createCalendarStore(fakeApi());
    const mine = meeting("ev_1", ["ana", "me"]);
    store.getState().applyEvent({ type: "calendar.event_created", event: mine, by: "ana" }, ME);
    store.getState().applyEvent({ type: "calendar.event_created", event: mine, by: "ana" }, ME);
    expect(Object.keys(store.getState().events)).toEqual(["ev_1"]);

    // Removed from the meeting: the update hides it.
    store
      .getState()
      .applyEvent(
        { type: "calendar.event_updated", event: meeting("ev_1", ["ana"]), by: "ana" },
        ME,
      );
    expect(store.getState().events.ev_1).toBeUndefined();

    // Someone else's pending request: visible to an admin, not to me.
    const pending = vacation("ev_v", "pending", "ana");
    store.getState().applyEvent({ type: "calendar.event_created", event: pending, by: "ana" }, ME);
    expect(store.getState().events.ev_v).toBeUndefined();
    store
      .getState()
      .applyEvent({ type: "calendar.event_created", event: pending, by: "ana" }, ADMIN);
    expect((store.getState().events.ev_v as VacationEvent | undefined)?.status).toBe("pending");

    store.getState().applyEvent({ type: "calendar.event_deleted", eventId: "ev_v", by: "ana" }, ME);
    expect(store.getState().events.ev_v).toBeUndefined();
  });

  it("an admin's allowance change lands in the team list and in mine when it's me", async () => {
    const store = createCalendarStore(fakeApi());
    store.setState({ year: "2026", mine: balance(), balances: [balance({ userId: "ana" })] });
    await store.getState().setAllowance("ana", "2026", 20);
    await store.getState().setAllowance("me", "2026", 16);
    expect(store.getState().balances.map((b) => [b.userId, b.allowance])).toEqual([
      ["ana", 20],
      ["me", 16],
    ]);
    expect(store.getState().mine?.allowance).toBe(16);
  });

  it("maps FullCalendar's exclusive range to inclusive dates and hides rejected requests", () => {
    expect(visibleRange({ start: new Date(2026, 9, 26), end: new Date(2026, 11, 7) })).toEqual({
      from: "2026-10-26",
      to: "2026-12-06",
    });
    expect(
      drawableEvents({
        a: vacation("a", "rejected"),
        b: vacation("b", "pending"),
        c: meeting("c", ["me"]),
      }).map((e) => e.eventId),
    ).toEqual(["b", "c"]);
  });
});
