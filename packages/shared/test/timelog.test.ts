import { describe, expect, it } from "vitest";
import {
  canDeleteTimeEntry,
  costOf,
  CreateTimeEntrySchema,
  formatMinutes,
  guestMayReceive,
  managesTimeRates,
  parseDuration,
  seesAllTime,
  SetTimeRateSchema,
  timeTotals,
  type TimeEntry,
} from "../src";

const entry = (userId: string, minutes: number, userName = userId): TimeEntry => ({
  entryId: `${userId}-${minutes}`,
  channelId: "ch_x",
  userId,
  userName,
  date: "2026-11-10",
  minutes,
  description: "work",
  createdAt: 1,
});

describe("hours per channel (Phase 60)", () => {
  it("reads durations as people type them", () => {
    expect(parseDuration("2")).toBe(120);
    expect(parseDuration("2,5")).toBe(150);
    expect(parseDuration("2h 30m")).toBe(150);
    expect(parseDuration("2:30")).toBe(150);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("90 min")).toBe(90);
    expect(parseDuration("1.5 horas")).toBe(90);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("mucho")).toBeNull();
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("25")).toBeNull(); // more than a day
    expect(formatMinutes(150)).toBe("2h 30m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(480)).toBe("8h");
  });

  it("adds hours and cost by person; hours without a rate are counted apart", () => {
    const totals = timeTotals([entry("dev", 90), entry("dev", 150), entry("ana", 60)], { dev: 25 });
    expect(totals.minutes).toBe(300);
    expect(totals.cost).toBe(100); // 4 h × $25
    expect(totals.unpricedMinutes).toBe(60);
    expect(totals.byUser.map((p) => [p.userId, p.minutes, p.cost])).toEqual([
      ["dev", 240, 100],
      ["ana", 60, 0],
    ]);
    expect(costOf(50, 20)).toBe(16.67);
  });

  it("keeps rates and costs to admins, and an external to their own entries", () => {
    expect(managesTimeRates("admin")).toBe(true);
    expect(managesTimeRates("member")).toBe(false);
    expect(managesTimeRates("guest")).toBe(false);
    expect(seesAllTime("member")).toBe(true);
    expect(seesAllTime("guest")).toBe(false);
    expect(canDeleteTimeEntry(entry("dev", 1), "dev", "guest")).toBe(true);
    expect(canDeleteTimeEntry(entry("dev", 1), "ana", "member")).toBe(false);
    expect(canDeleteTimeEntry(entry("dev", 1), "ana", "admin")).toBe(true);
    expect(guestMayReceive("time.updated")).toBe(true);
  });

  it("validates an entry and a rate", () => {
    const ok = { date: "2026-11-10", minutes: 90, description: " API de pagos " };
    expect(CreateTimeEntrySchema.parse(ok).description).toBe("API de pagos");
    expect(CreateTimeEntrySchema.safeParse({ ...ok, minutes: 0 }).success).toBe(false);
    expect(CreateTimeEntrySchema.safeParse({ ...ok, date: "10/11/2026" }).success).toBe(false);
    expect(CreateTimeEntrySchema.safeParse({ ...ok, description: " " }).success).toBe(false);
    expect(SetTimeRateSchema.safeParse({ hourlyRate: 22.5 }).success).toBe(true);
    expect(SetTimeRateSchema.safeParse({ hourlyRate: -1 }).success).toBe(false);
    expect(SetTimeRateSchema.safeParse({ hourlyRate: 1.234 }).success).toBe(false);
  });
});
