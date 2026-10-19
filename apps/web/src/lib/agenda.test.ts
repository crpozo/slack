import type { CalendarEvent } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  addMonths,
  eventsByDate,
  JOIN_WINDOW_MS,
  joinState,
  monthDays,
  monthsRange,
  monthTitle,
} from "./agenda";

const base = { description: "", createdBy: "u", createdAt: 1, updatedAt: 1 };
const holiday: CalendarEvent = {
  ...base,
  eventId: "h",
  type: "holiday",
  title: "Navidad",
  allDay: true,
  startAt: 1,
  endAt: 2,
  startDate: "2026-12-25",
  endDate: "2026-12-25",
};
const vacation: CalendarEvent = {
  ...base,
  eventId: "v",
  type: "vacation",
  title: "Vacation",
  allDay: true,
  startAt: 1,
  endAt: 2,
  startDate: "2026-12-24",
  endDate: "2026-12-26",
  participants: ["ana"],
  status: "approved",
  days: 2,
  note: "",
};
// 15:00Z on Dec 25 = 10:00 in Guayaquil.
const meeting: CalendarEvent = {
  ...base,
  eventId: "m",
  type: "meeting",
  title: "Standup",
  allDay: false,
  startAt: Date.UTC(2026, 11, 25, 15),
  endAt: Date.UTC(2026, 11, 25, 15, 30),
  participants: ["ana", "me"],
};

describe("agenda months", () => {
  it("walks months and lists their days", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-10", 14)).toBe("2027-12");
    expect(monthDays("2026-02")).toHaveLength(28);
    expect(monthDays("2028-02")).toHaveLength(29);
    expect(monthDays("2026-10")[0]).toBe("2026-10-01");
    expect(monthDays("2026-10").at(-1)).toBe("2026-10-31");
    expect(monthsRange(["2026-12", "2027-01"])).toEqual({ from: "2026-12-01", to: "2027-01-31" });
    expect(monthTitle("2026-10")).toBe("October 2026");
  });

  it("groups events by every day they cover, holidays first then all-day then timed", () => {
    const byDate = eventsByDate([meeting, vacation, holiday]);
    expect([...byDate.keys()].sort()).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
    expect(byDate.get("2026-12-25")!.map((e) => e.eventId)).toEqual(["h", "v", "m"]);
    expect(byDate.get("2026-12-24")!.map((e) => e.eventId)).toEqual(["v"]);
  });
});

describe("join window", () => {
  const m = { startAt: 1_000_000, endAt: 1_000_000 + 30 * 60_000 };
  it("opens five minutes before the start and closes at the end", () => {
    expect(joinState(m, m.startAt - JOIN_WINDOW_MS - 1)).toBe("upcoming");
    expect(joinState(m, m.startAt - JOIN_WINDOW_MS)).toBe("open");
    expect(joinState(m, m.startAt + 10_000)).toBe("open");
    expect(joinState(m, m.endAt - 1)).toBe("open");
    expect(joinState(m, m.endAt)).toBe("over");
  });
});
