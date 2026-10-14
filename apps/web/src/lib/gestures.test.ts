import { describe, expect, it, vi } from "vitest";
import {
  CLICK_GUARD_MS,
  classifyDrag,
  SLOP_PX,
  swallowNextClick,
  swipeOffset,
  SWIPE_MAX_PX,
  SWIPE_TRIGGER_PX,
} from "./gestures";

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

describe("swallowNextClick", () => {
  // No DOM in this environment: a bare EventTarget stands in for `document`.
  const withDocument = (fn: (doc: EventTarget) => void) => {
    const doc = new EventTarget();
    vi.stubGlobal("document", doc);
    try {
      fn(doc);
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const click = () => new Event("click", { cancelable: true });

  it("cancels the click synthesized right after a touch drag, and only that one", () => {
    withDocument((doc) => {
      swallowNextClick();
      const swallowed = click();
      doc.dispatchEvent(swallowed);
      expect(swallowed.defaultPrevented).toBe(true);
      const next = click();
      doc.dispatchEvent(next);
      expect(next.defaultPrevented).toBe(false);
    });
  });

  it("lets a click through once the guard has expired", () => {
    vi.useFakeTimers();
    try {
      withDocument((doc) => {
        swallowNextClick();
        vi.advanceTimersByTime(CLICK_GUARD_MS + 1);
        const late = click();
        doc.dispatchEvent(late);
        expect(late.defaultPrevented).toBe(false);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
