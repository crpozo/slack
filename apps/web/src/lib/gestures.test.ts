import { describe, expect, it } from "vitest";
import { classifyDrag, SLOP_PX, swipeOffset, SWIPE_MAX_PX, SWIPE_TRIGGER_PX } from "./gestures";

describe("classifyDrag", () => {
  it("stays undecided within the slop, so a still finger can long-press", () => {
    expect(classifyDrag(0, 0)).toBe("pending");
    expect(classifyDrag(SLOP_PX - 1, 0)).toBe("pending");
    expect(classifyDrag(5, 5)).toBe("pending");
  });

  it("picks the dominant axis once the finger travels", () => {
    expect(classifyDrag(30, 8)).toBe("horizontal");
    expect(classifyDrag(-30, 8)).toBe("horizontal");
    expect(classifyDrag(8, 30)).toBe("vertical"); // scrolling: left to the browser
    expect(classifyDrag(12, -40)).toBe("vertical");
  });
});

describe("swipeOffset", () => {
  it("follows the finger rightwards, never leftwards", () => {
    expect(swipeOffset(-50)).toBe(0);
    expect(swipeOffset(0)).toBe(0);
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(SWIPE_TRIGGER_PX)).toBe(SWIPE_TRIGGER_PX);
  });

  it("resists past the trigger and stops at the max", () => {
    expect(swipeOffset(SWIPE_TRIGGER_PX + 30)).toBe(SWIPE_TRIGGER_PX + 10);
    expect(swipeOffset(500)).toBe(SWIPE_MAX_PX);
  });
});
