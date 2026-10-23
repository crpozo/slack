import { describe, expect, it } from "vitest";
import {
  CreateMeetingSchema,
  describeRecurrence,
  expandEvents,
  isSeriesDate,
  lastSeriesDate,
  meetingCardOf,
  meetingCardText,
  nextOccurrence,
  nextSeriesDate,
  occurrenceDates,
  occurrenceKey,
  occurrencesOf,
  recurrenceProblem,
  RecurrenceSchema,
  seriesEndAt,
  UpdateEventSchema,
  zonedMidnight,
  type MeetingEvent,
  type Recurrence,
} from "../src";

const HOUR = 3_600_000;
const weekly = (byWeekday: number[], extra: Partial<Recurrence> = {}): Recurrence => ({
  freq: "weekly",
  interval: 1,
  byWeekday,
  ...extra,
});

/** A 10:00–10:30 (Ecuador) standup on Monday 2026-10-26, every weekday. */
const standup: MeetingEvent = {
  eventId: "ev_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  type: "meeting",
  title: "Standup",
  description: "",
  allDay: false,
  startAt: zonedMidnight("2026-10-26") + 10 * HOUR,
  endAt: zonedMidnight("2026-10-26") + 10.5 * HOUR,
  participants: ["a", "b"],
  createdBy: "a",
  createdAt: 1,
  updatedAt: 1,
  recurrence: weekly([1, 2, 3, 4, 5]),
};

describe("RecurrenceSchema", () => {
  it("normalizes weekdays and defaults the interval", () => {
    expect(RecurrenceSchema.parse({ freq: "weekly", byWeekday: [5, 1, 1] })).toEqual({
      freq: "weekly",
      interval: 1,
      byWeekday: [1, 5],
    });
  });

  it("rejects contradictions", () => {
    expect(RecurrenceSchema.safeParse({ freq: "weekly" }).success).toBe(false);
    expect(RecurrenceSchema.safeParse({ freq: "daily", byWeekday: [1] }).success).toBe(false);
    expect(
      RecurrenceSchema.safeParse({ freq: "daily", until: "2026-12-01", count: 3 }).success,
    ).toBe(false);
    expect(RecurrenceSchema.safeParse({ freq: "daily", interval: 0 }).success).toBe(false);
    expect(RecurrenceSchema.safeParse({ freq: "daily", count: 1 }).success).toBe(false);
    expect(RecurrenceSchema.safeParse({ freq: "yearly" }).success).toBe(false);
  });
});

describe("recurrenceProblem", () => {
  it("wants the first meeting on one of the weekdays", () => {
    expect(recurrenceProblem(weekly([2]), "2026-10-26")).toMatch(/weekday/); // a Monday
    expect(recurrenceProblem(weekly([1, 3]), "2026-10-26")).toBeNull();
  });

  it("bounds the end date", () => {
    const daily = { freq: "daily", interval: 1 } as const;
    expect(recurrenceProblem({ ...daily, until: "2026-10-01" }, "2026-10-26")).toMatch(/before/);
    expect(recurrenceProblem({ ...daily, until: "2040-01-01" }, "2026-10-26")).toMatch(/ten/);
  });
});

describe("occurrenceDates", () => {
  it("daily every 2 days, skipping cancelled dates", () => {
    const rule: Recurrence = { freq: "daily", interval: 2 };
    expect(occurrenceDates("2026-10-26", rule, "2026-10-26", "2026-11-03", ["2026-10-30"])).toEqual(
      ["2026-10-26", "2026-10-28", "2026-11-01", "2026-11-03"],
    );
  });

  it("weekly on weekdays, from a later window", () => {
    expect(
      occurrenceDates("2026-10-26", weekly([1, 2, 3, 4, 5]), "2026-11-06", "2026-11-10"),
    ).toEqual(["2026-11-06", "2026-11-09", "2026-11-10"]);
  });

  it("every 2 weeks on Mon and Thu", () => {
    const rule = weekly([1, 4], { interval: 2 });
    expect(occurrenceDates("2026-10-26", rule, "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-26",
      "2026-10-29",
      "2026-11-09",
      "2026-11-12",
      "2026-11-23",
      "2026-11-26",
    ]);
  });

  it("monthly on the 31st skips shorter months", () => {
    const rule: Recurrence = { freq: "monthly", interval: 1 };
    expect(occurrenceDates("2026-08-31", rule, "2026-08-01", "2027-01-31")).toEqual([
      "2026-08-31",
      "2026-10-31",
      "2026-12-31",
      "2027-01-31",
    ]);
  });

  it("stops after `count` (cancelled dates still count) and at `until`", () => {
    const counted: Recurrence = { freq: "daily", interval: 1, count: 3 };
    expect(
      occurrenceDates("2026-10-26", counted, "2026-10-01", "2026-12-31", ["2026-10-27"]),
    ).toEqual(["2026-10-26", "2026-10-28"]);
    const until: Recurrence = { freq: "weekly", interval: 1, byWeekday: [1], until: "2026-11-09" };
    expect(occurrenceDates("2026-10-26", until, "2026-10-01", "2026-12-31")).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    // Counting must start from the beginning even when the window is late.
    expect(
      occurrenceDates(
        "2026-10-26",
        { freq: "daily", interval: 1, count: 5 },
        "2026-10-29",
        "2026-12-31",
      ),
    ).toEqual(["2026-10-29", "2026-10-30"]);
  });

  it("finds a window years later without walking every date", () => {
    expect(occurrenceDates("2026-10-26", weekly([1]), "2036-01-01", "2036-01-14")).toEqual([
      "2036-01-07",
      "2036-01-14",
    ]);
  });
});

describe("series bounds", () => {
  it("lastSeriesDate", () => {
    expect(lastSeriesDate("2026-10-26", { freq: "daily", interval: 1, count: 3 })).toBe(
      "2026-10-28",
    );
    expect(lastSeriesDate("2026-10-26", { freq: "daily", interval: 1 })).toBeNull();
  });

  it("isSeriesDate and nextSeriesDate", () => {
    expect(isSeriesDate("2026-10-26", weekly([1, 2, 3, 4, 5]), "2026-10-31")).toBe(false);
    expect(isSeriesDate("2026-10-26", weekly([1, 2, 3, 4, 5]), "2026-11-02")).toBe(true);
    expect(
      nextSeriesDate("2026-10-26", weekly([1, 2, 3, 4, 5]), "2026-10-31", ["2026-11-02"]),
    ).toBe("2026-11-03");
  });
});

describe("occurrences of a meeting", () => {
  it("keeps the time of day and the length", () => {
    const week = occurrencesOf(standup, "2026-10-26", "2026-11-01");
    expect(week).toHaveLength(5);
    const friday = week[4] as MeetingEvent;
    expect(friday.occurrence).toBe("2026-10-30");
    expect(friday.startAt).toBe(zonedMidnight("2026-10-30") + 10 * HOUR);
    expect(friday.endAt - friday.startAt).toBe(30 * 60_000);
    expect(occurrenceKey(friday)).toBe(`${standup.eventId}@2026-10-30`);
  });

  it("leaves other events alone and expands lists", () => {
    const single = { ...standup, recurrence: undefined };
    expect(occurrencesOf(single, "2026-10-26", "2026-10-26")).toEqual([single]);
    expect(expandEvents([single, standup], "2026-10-26", "2026-10-27")).toHaveLength(3);
  });

  it("expands all-day series by date", () => {
    const offsite: MeetingEvent = {
      ...standup,
      allDay: true,
      startDate: "2026-10-30",
      endDate: "2026-10-30",
      startAt: zonedMidnight("2026-10-30"),
      endAt: zonedMidnight("2026-10-31"),
      recurrence: { freq: "monthly", interval: 1 },
    };
    const [nov] = occurrencesOf(offsite, "2026-11-01", "2026-11-30") as MeetingEvent[];
    expect(nov).toMatchObject({ startDate: "2026-11-30", endDate: "2026-11-30" });
  });

  it("nextOccurrence: the one on now, then the next, null when over", () => {
    const during = zonedMidnight("2026-10-27") + 10.25 * HOUR;
    expect(nextOccurrence(standup, during)?.occurrence).toBe("2026-10-27");
    const after = zonedMidnight("2026-10-30") + 11 * HOUR; // Friday after the standup
    expect(nextOccurrence(standup, after)?.occurrence).toBe("2026-11-02");
    const short = { ...standup, recurrence: weekly([1, 2, 3, 4, 5], { count: 2 }) };
    expect(nextOccurrence(short, after)).toBeNull();
    expect(seriesEndAt(short)).toBe(zonedMidnight("2026-10-27") + 10.5 * HOUR);
    expect(seriesEndAt(standup)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("describeRecurrence and card text", () => {
  it("reads like a person would say it", () => {
    expect(describeRecurrence(weekly([1, 2, 3, 4, 5]), "2026-10-26")).toBe("Every weekday");
    expect(describeRecurrence(weekly([1]), "2026-10-26")).toBe("Weekly on Monday");
    expect(describeRecurrence(weekly([1, 4], { interval: 2 }), "2026-10-26")).toBe(
      "Every 2 weeks on Mon, Thu",
    );
    expect(describeRecurrence({ freq: "monthly", interval: 1, count: 6 }, "2026-10-22")).toBe(
      "Monthly on the 22nd, 6 times",
    );
    expect(
      describeRecurrence({ freq: "daily", interval: 3, until: "2026-12-18" }, "2026-10-26"),
    ).toBe("Every 3 days, until Dec 18, 2026");
    expect(describeRecurrence({ freq: "monthly", interval: 2 }, "2026-10-11")).toBe(
      "Every 2 months on the 11th",
    );
  });

  it("series and cancelled cards", () => {
    const card = meetingCardOf(standup);
    expect(card.recurrence).toEqual(standup.recurrence);
    expect(meetingCardText(card)).toBe("📅 Meeting scheduled: Standup · Every weekday at 10:00 AM");
    expect(meetingCardText({ ...card, cancelled: true })).toBe("📅 Meeting cancelled: Standup");
  });
});

describe("schemas", () => {
  const base = {
    type: "meeting" as const,
    title: "Standup",
    startAt: standup.startAt,
    endAt: standup.endAt,
  };

  it("accepts a series and checks its first date", () => {
    expect(CreateMeetingSchema.safeParse({ ...base, recurrence: weekly([1, 3]) }).success).toBe(
      true,
    );
    expect(CreateMeetingSchema.safeParse({ ...base, recurrence: weekly([3]) }).success).toBe(false);
  });

  it("only single-day all-day series", () => {
    const allDay = { type: "meeting" as const, title: "Offsite", allDay: true };
    const rule = { freq: "monthly", interval: 1 } as const;
    expect(
      CreateMeetingSchema.safeParse({
        ...allDay,
        startDate: "2026-10-30",
        endDate: "2026-10-31",
        recurrence: rule,
      }).success,
    ).toBe(false);
    expect(
      CreateMeetingSchema.safeParse({
        ...allDay,
        startDate: "2026-10-30",
        endDate: "2026-10-30",
        recurrence: rule,
      }).success,
    ).toBe(true);
  });

  it("an edit may drop the rule", () => {
    expect(UpdateEventSchema.parse({ recurrence: null })).toEqual({ recurrence: null });
  });
});
