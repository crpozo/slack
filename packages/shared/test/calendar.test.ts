import { describe, expect, it } from "vitest";
import {
  addDays,
  allDaySpan,
  canSeeEvent,
  countVacationDays,
  CreateEventSchema,
  dateInZone,
  datesOverlap,
  daysBetween,
  describeEventWhen,
  eachDate,
  isDateString,
  isWeekend,
  ListEventsQuerySchema,
  MAX_EVENT_DAYS,
  meetingCardOf,
  meetingCardText,
  remainingDays,
  UpdateEventSchema,
  VacationDecisionSchema,
  zonedMidnight,
  type CalendarEvent,
  type MeetingEvent,
  type VacationEvent,
} from "../src";

const base = {
  eventId: "ev_1",
  title: "x",
  description: "",
  startAt: 1,
  endAt: 2,
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1,
};
const vacation = (status: VacationEvent["status"]): VacationEvent => ({
  ...base,
  type: "vacation",
  allDay: true,
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  participants: ["u1"],
  status,
  days: 5,
  note: "",
});
const meeting: MeetingEvent = {
  ...base,
  type: "meeting",
  allDay: false,
  participants: ["u1", "u2"],
};
const holiday: CalendarEvent = {
  ...base,
  type: "holiday",
  allDay: true,
  startDate: "2026-12-25",
  endDate: "2026-12-25",
};

describe("dates", () => {
  it("validates and walks YYYY-MM-DD strings without a timezone", () => {
    expect(isDateString("2026-02-28")).toBe(true);
    expect(isDateString("2026-02-30")).toBe(false);
    expect(isDateString("2026-2-3")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
    expect(eachDate("2026-01-30", "2026-02-01")).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
    ]);
    expect(eachDate("2026-01-02", "2026-01-01")).toEqual([]);
    expect(isWeekend("2026-10-17")).toBe(true); // Saturday
    expect(isWeekend("2026-10-19")).toBe(false); // Monday
  });

  it("anchors all-day events to midnight in Ecuador (UTC-5), not the host's zone", () => {
    // 2026-08-10 00:00 in Guayaquil is 05:00Z.
    expect(zonedMidnight("2026-08-10")).toBe(Date.UTC(2026, 7, 10, 5));
    expect(allDaySpan("2026-08-10", "2026-08-10")).toEqual({
      startAt: Date.UTC(2026, 7, 10, 5),
      endAt: Date.UTC(2026, 7, 11, 5),
    });
    // 03:00Z on the 10th is still the 9th in Guayaquil.
    expect(dateInZone(Date.UTC(2026, 7, 10, 3))).toBe("2026-08-09");
    expect(dateInZone(Date.UTC(2026, 7, 10, 5))).toBe("2026-08-10");
    // A zone with DST gets the right offset on either side of the change.
    expect(zonedMidnight("2026-07-01", "America/New_York")).toBe(Date.UTC(2026, 6, 1, 4));
    expect(zonedMidnight("2026-01-01", "America/New_York")).toBe(Date.UTC(2026, 0, 1, 5));
  });
});

describe("vacation ledger", () => {
  it("counts Monday–Friday only, skipping national holidays", () => {
    // 2026-11-02 (Mon) .. 2026-11-08 (Sun): 5 working days; Nov 3 is a holiday.
    expect(countVacationDays("2026-11-02", "2026-11-08")).toBe(5);
    expect(countVacationDays("2026-11-02", "2026-11-08", new Set(["2026-11-03"]))).toBe(4);
    expect(countVacationDays("2026-10-17", "2026-10-18")).toBe(0); // a weekend
    expect(countVacationDays("2026-10-19", "2026-10-19")).toBe(1);
  });

  it("reserves pending days against the allowance", () => {
    expect(remainingDays({ allowance: 15, used: 5, pending: 3 })).toBe(7);
    expect(remainingDays({ allowance: 10, used: 10, pending: 3 })).toBe(0);
  });

  it("detects overlapping date ranges", () => {
    const a = { startDate: "2026-11-02", endDate: "2026-11-06" };
    expect(datesOverlap(a, { startDate: "2026-11-06", endDate: "2026-11-10" })).toBe(true);
    expect(datesOverlap(a, { startDate: "2026-11-07", endDate: "2026-11-10" })).toBe(false);
    expect(datesOverlap(a, { startDate: "2026-10-01", endDate: "2026-11-02" })).toBe(true);
  });
});

describe("visibility", () => {
  it("holidays and approved vacations are company-wide", () => {
    expect(canSeeEvent(holiday, { userId: "u9" })).toBe(true);
    expect(canSeeEvent(vacation("approved"), { userId: "u9" })).toBe(true);
  });

  it("pending and rejected vacations are for the requester and admins", () => {
    expect(canSeeEvent(vacation("pending"), { userId: "u1" })).toBe(true);
    expect(canSeeEvent(vacation("pending"), { userId: "u9", role: "admin" })).toBe(true);
    expect(canSeeEvent(vacation("pending"), { userId: "u9" })).toBe(false);
    expect(canSeeEvent(vacation("rejected"), { userId: "u1" })).toBe(true);
    expect(canSeeEvent(vacation("rejected"), { userId: "u9", role: "admin" })).toBe(true);
    expect(canSeeEvent(vacation("rejected"), { userId: "u9" })).toBe(false);
  });

  it("meetings are for their participants; guests see nothing", () => {
    expect(canSeeEvent(meeting, { userId: "u2" })).toBe(true);
    expect(canSeeEvent(meeting, { userId: "u3" })).toBe(false);
    expect(canSeeEvent(meeting, { userId: "u3", role: "admin" })).toBe(false);
    expect(canSeeEvent(holiday, { userId: "u1", role: "guest" })).toBe(false);
  });
});

describe("schemas", () => {
  it("accepts a timed meeting of 5 minutes to a day, with an optional guest list", () => {
    const startAt = 1_700_000_000_000;
    const ok = CreateEventSchema.parse({
      type: "meeting",
      title: " Daily standup ",
      startAt,
      endAt: startAt + 30 * 60_000,
    });
    expect(ok).toMatchObject({ title: "Daily standup", allDay: false, participants: [] });
    const bad = (patch: Record<string, unknown>) =>
      CreateEventSchema.safeParse({ ...ok, ...patch }).success;
    expect(bad({ endAt: startAt + 60_000 })).toBe(false);
    expect(bad({ endAt: startAt + 25 * 3_600_000 })).toBe(false);
    expect(bad({ startAt: undefined })).toBe(false);
    expect(bad({ title: "" })).toBe(false);
  });

  it("accepts all-day meetings, holidays and vacations as date ranges", () => {
    expect(
      CreateEventSchema.safeParse({
        type: "meeting",
        title: "Offsite",
        allDay: true,
        startDate: "2026-11-05",
        endDate: "2026-11-06",
      }).success,
    ).toBe(true);
    expect(
      CreateEventSchema.safeParse({ type: "meeting", title: "Offsite", allDay: true }).success,
    ).toBe(false);
    expect(
      CreateEventSchema.parse({ type: "holiday", title: "Navidad", startDate: "2026-12-25" }),
    ).toMatchObject({ title: "Navidad", description: "" });
    expect(
      CreateEventSchema.safeParse({
        type: "vacation",
        startDate: "2026-11-09",
        endDate: addDays("2026-11-09", MAX_EVENT_DAYS),
      }).success,
    ).toBe(false);
    expect(
      CreateEventSchema.safeParse({
        type: "vacation",
        startDate: "2026-11-09",
        endDate: "2026-11-08",
      }).success,
    ).toBe(false);
    expect(CreateEventSchema.safeParse({ type: "vacation", startDate: "2026-02-30" }).success).toBe(
      false,
    );
  });

  it("requires something to update, a decision, and a bounded listing range", () => {
    expect(UpdateEventSchema.safeParse({}).success).toBe(false);
    expect(UpdateEventSchema.safeParse({ title: "New" }).success).toBe(true);
    expect(VacationDecisionSchema.parse({ status: "approved" })).toEqual({
      status: "approved",
      note: "",
    });
    expect(VacationDecisionSchema.safeParse({ status: "pending" }).success).toBe(false);
    expect(ListEventsQuerySchema.safeParse({ from: "2026-01-01", to: "2026-02-11" }).success).toBe(
      true,
    );
    expect(ListEventsQuerySchema.safeParse({ from: "2026-01-01", to: "2026-05-01" }).success).toBe(
      false,
    );
    expect(ListEventsQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success).toBe(
      false,
    );
  });

  it("describes when an event happens", () => {
    expect(describeEventWhen({ ...holiday, allDay: true })).toBe("2026-12-25");
    expect(describeEventWhen({ ...vacation("pending"), allDay: true })).toBe(
      "2026-11-02 → 2026-11-06",
    );
    expect(describeEventWhen({ allDay: false, startAt: Date.UTC(2026, 10, 2, 15), endAt: 0 })).toBe(
      "Nov 2, 10:00 AM",
    );
  });
});

describe("meetings scheduled from a direct message", () => {
  const startAt = Date.UTC(2026, 10, 4, 15);
  const base = { type: "meeting", title: "Kickoff", startAt, endAt: startAt + 3_600_000 };

  it("take their participants from the conversation, never from the body", () => {
    const ok = CreateEventSchema.parse({ ...base, channelId: "dm_a_b", clientId: "c1" });
    expect(ok).toMatchObject({ channelId: "dm_a_b", clientId: "c1", participants: [] });
    expect(
      CreateEventSchema.safeParse({ ...base, channelId: "dm_a_b", participants: ["u9"] }).success,
    ).toBe(false);
    expect(
      CreateEventSchema.safeParse({
        type: "meeting",
        title: "x",
        channelId: "dm_a_b",
        allDay: true,
        startDate: "2026-11-04",
        endDate: "2026-11-04",
      }).success,
    ).toBe(false);
  });

  it("have a plain-text fallback for the card", () => {
    expect(meetingCardText({ title: "Kickoff", startAt, endAt: startAt + 3_600_000 })).toBe(
      "📅 Meeting scheduled: Kickoff · Nov 4, 10:00 AM",
    );
    expect(
      meetingCardText({
        title: "Offsite",
        allDay: true,
        startAt,
        endAt: startAt,
        startDate: "2026-11-04",
        endDate: "2026-11-05",
      }),
    ).toBe("📅 Meeting scheduled: Offsite · 2026-11-04 → 2026-11-05");
  });

  it("derive the card from the event as it stands, dates only when all-day", () => {
    const meeting = {
      eventId: "ev_1",
      type: "meeting" as const,
      title: "Kickoff",
      description: "Agenda",
      allDay: false,
      startAt,
      endAt: startAt + 3_600_000,
      participants: ["user-a", "user-b"],
      createdBy: "user-a",
      createdAt: 1,
      updatedAt: 2,
      channelId: "dm_user-a_user-b",
      messageId: "m1",
      messageSk: "1#m1",
    };
    expect(meetingCardOf(meeting)).toEqual({
      eventId: "ev_1",
      title: "Kickoff",
      description: "Agenda",
      allDay: false,
      startAt,
      endAt: startAt + 3_600_000,
      participants: ["user-a", "user-b"],
    });
    expect(
      meetingCardOf({
        ...meeting,
        allDay: true,
        ...allDaySpan("2026-11-04", "2026-11-04"),
        startDate: "2026-11-04",
        endDate: "2026-11-04",
      }),
    ).toMatchObject({ allDay: true, startDate: "2026-11-04", endDate: "2026-11-04" });
  });
});
