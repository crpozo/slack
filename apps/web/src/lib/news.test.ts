import { describe, expect, it } from "vitest";
import { fullDate, relativeTime } from "./news";

describe("news dates", () => {
  const now = Date.parse("2026-10-26T15:00:00Z");
  it("reads like a feed", () => {
    expect(relativeTime("2026-10-26T14:59:30Z", now)).toBe("Just now");
    expect(relativeTime("2026-10-26T14:48:00Z", now)).toBe("12 min ago");
    expect(relativeTime("2026-10-26T12:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-24T15:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("2026-10-10T15:00:00Z", now)).toBe("Oct 10");
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("not a date", now)).toBe("");
    expect(relativeTime("2026-10-26T16:00:00Z", now)).toBe("Just now"); // a clock a bit ahead
  });

  it("spells the full date for tooltips", () => {
    expect(fullDate("2026-10-26T15:00:00Z")).toMatch(/Oct 26, 2026/);
    expect(fullDate(null)).toBe("");
  });
});
