import type { CalendarEvent, VacationEvent } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  addMinutes,
  eventLabel,
  formatDate,
  formatDateRange,
  holidayDates,
  joinLocal,
  splitLocal,
  toCalendarInput,
} from "./calendarUi";

const nameOf = (id: string) => ({ ana: "Ana", me: "Carlos" })[id] ?? id;
const base = { description: "", createdBy: "ana", createdAt: 1, updatedAt: 1 };
const holiday: CalendarEvent = {
  ...base,
  eventId: "h",
  type: "holiday",
  title: "Navidad",
  allDay: true,
  startAt: 1,
  endAt: 2,
  startDate: "2026-12-25",
  endDate: "2026-12-26",
};
const pending: VacationEvent = {
  ...base,
  eventId: "v",
  type: "vacation",
  title: "Vacation",
  allDay: true,
  startAt: 1,
  endAt: 2,
  startDate: "2026-11-02",
  endDate: "2026-11-06",
  participants: ["ana"],
  status: "pending",
  days: 5,
  note: "",
};

describe("calendar UI mapping", () => {
  it("draws all-day events from their dates (exclusive end), never from instants", () => {
    const input = toCalendarInput(holiday, nameOf);
    expect(input).toMatchObject({
      id: "h",
      title: "Navidad",
      allDay: true,
      start: "2026-12-25",
      end: "2026-12-27",
      classNames: ["ev-holiday"],
      rank: 0,
    });
    expect(toCalendarInput(pending, nameOf)).toMatchObject({
      title: "Ana · Vacation (pending)",
      classNames: ["ev-vacation", "ev-pending"],
      rank: 1,
      end: "2026-11-07",
    });
    expect(eventLabel({ ...pending, status: "approved" }, nameOf)).toBe("Ana · Vacation");
  });

  it("draws timed meetings as instants in local time", () => {
    const startAt = Date.UTC(2026, 10, 3, 15);
    const input = toCalendarInput(
      {
        ...base,
        eventId: "m",
        type: "meeting",
        title: "Standup",
        allDay: false,
        startAt,
        endAt: startAt + 1_800_000,
        participants: ["ana", "me"],
      },
      nameOf,
    );
    expect(input).toMatchObject({ allDay: false, classNames: ["ev-meeting"], rank: 2 });
    expect((input.start as Date).getTime()).toBe(startAt);
  });

  it("collects holiday dates and formats dates without shifting them", () => {
    expect([...holidayDates([holiday, pending])]).toEqual(["2026-12-25", "2026-12-26"]);
    expect(formatDate("2026-11-02", "2026")).toBe("Mon, Nov 2");
    expect(formatDate("2027-01-01", "2026")).toBe("Fri, Jan 1, 2027");
    expect(formatDateRange("2026-11-02", "2026-11-02")).toMatch(/^Mon, Nov 2/);
    expect(formatDateRange("2026-11-02", "2026-11-06")).toMatch(/^Mon, Nov 2.* – Fri, Nov 6/);
  });

  it("splits and joins local date/time inputs", () => {
    const at = new Date(2026, 10, 3, 9, 5).getTime();
    expect(splitLocal(at)).toEqual({ date: "2026-11-03", time: "09:05" });
    expect(joinLocal("2026-11-03", "09:05")).toBe(at);
    expect(joinLocal("", "09:05")).toBeNull();
    expect(addMinutes("09:45", 30)).toBe("10:15");
    expect(addMinutes("23:50", 30)).toBe("23:59");
  });
});
