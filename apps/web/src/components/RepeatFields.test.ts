import { describe, expect, it } from "vitest";
import { presetOf, ruleOf, withFirstWeekday } from "./RepeatFields";

const MONDAY = "2026-10-26";

describe("Repeat presets", () => {
  it("names the rule the way the menu does", () => {
    expect(presetOf(null, MONDAY)).toBe("none");
    expect(presetOf({ freq: "daily", interval: 1 }, MONDAY)).toBe("daily");
    expect(presetOf({ freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5] }, MONDAY)).toBe(
      "weekdays",
    );
    expect(presetOf({ freq: "weekly", interval: 1, byWeekday: [1] }, MONDAY)).toBe("weekly");
    expect(presetOf({ freq: "weekly", interval: 1, byWeekday: [1, 3] }, MONDAY)).toBe("custom");
    expect(presetOf({ freq: "monthly", interval: 2 }, MONDAY)).toBe("custom");
  });

  it("builds a preset's rule, keeping how it ends", () => {
    expect(ruleOf("weekly", MONDAY, { count: 5 })).toEqual({
      freq: "weekly",
      interval: 1,
      byWeekday: [1],
      count: 5,
    });
    expect(ruleOf("monthly", MONDAY, { until: "2027-01-01" })).toEqual({
      freq: "monthly",
      interval: 1,
      until: "2027-01-01",
    });
    expect(ruleOf("none", MONDAY, {})).toBeNull();
  });

  it("keeps the first meeting's weekday in a weekly rule", () => {
    const rule = { freq: "weekly" as const, interval: 1, byWeekday: [1] };
    // Moved to a Wednesday: "weekly on" follows it; a custom set gains it.
    expect(withFirstWeekday(rule, "2026-10-28", true).byWeekday).toEqual([3]);
    expect(withFirstWeekday(rule, "2026-10-28", false).byWeekday).toEqual([1, 3]);
    expect(withFirstWeekday(rule, MONDAY, false)).toBe(rule);
  });
});
