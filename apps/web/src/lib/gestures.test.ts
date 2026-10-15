import { describe, expect, it, vi } from "vitest";
import {
  attachEdgeSwipe,
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
  const click = () => new Event("click", { cancelable: true });

  it("cancels every click during the guard window, then lets clicks through again", () => {
    vi.useFakeTimers();
    const doc = new EventTarget();
    vi.stubGlobal("document", doc);
    try {
      swallowNextClick();
      const first = click();
      doc.dispatchEvent(first);
      const second = click(); // e.g. a ghost click plus its compat click
      doc.dispatchEvent(second);
      expect(first.defaultPrevented).toBe(true);
      expect(second.defaultPrevented).toBe(true);
      vi.advanceTimersByTime(CLICK_GUARD_MS + 1);
      const late = click();
      doc.dispatchEvent(late);
      expect(late.defaultPrevented).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("attachEdgeSwipe (the drawer)", () => {
  /** Synthetic events: Node has no PointerEvent/TouchEvent, so fields are assigned. */
  const pointer = (type: string, x: number, y = 300) =>
    Object.assign(new Event(type, { cancelable: true }), {
      pointerType: "touch",
      pointerId: 1,
      clientX: x,
      clientY: y,
    });
  const touch = (type: string, x: number, target: EventTarget | null = null) => {
    const e = Object.assign(new Event(type, { cancelable: true }), {
      touches: type === "touchend" ? [] : [{ clientX: x, clientY: 300 }],
    });
    if (target) Object.defineProperty(e, "target", { value: target });
    return e;
  };

  function setup(open = false) {
    vi.useFakeTimers();
    const doc = new EventTarget();
    vi.stubGlobal("document", doc);
    const calls = { opened: 0, closed: 0, progress: [] as Array<number | null> };
    const detach = attachEdgeSwipe(doc, {
      open,
      width: 280,
      onOpen: () => calls.opened++,
      onClose: () => calls.closed++,
      onProgress: (p) => calls.progress.push(p),
    });
    const send = (e: Event) => {
      doc.dispatchEvent(e);
      return e;
    };
    return { doc, calls, send, detach };
  }
  const done = () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  };

  it("opens from the edge and cancels the touchend, so no click lands on #general", () => {
    const { calls, send } = setup();
    try {
      const start = send(touch("touchstart", 5));
      send(pointer("pointerdown", 5));
      send(pointer("pointermove", 60));
      const move = send(touch("touchmove", 60));
      send(pointer("pointermove", 200));
      send(pointer("pointerup", 200));
      const end = send(touch("touchend", 200));

      expect(calls.opened).toBe(1);
      expect(start.defaultPrevented).toBe(true); // iOS: no history-back swipe
      expect(move.defaultPrevented).toBe(true); // no scroll/overscroll meanwhile
      expect(end.defaultPrevented).toBe(true); // no synthesized click
      expect(calls.progress.at(-1)).toBeNull();
      // And the backstop: a click arriving anyway is swallowed.
      expect(send(new Event("click", { cancelable: true })).defaultPrevented).toBe(true);
    } finally {
      done();
    }
  });

  it("leaves taps alone: on buttons in the edge strip, and everywhere else", () => {
    const { calls, send } = setup();
    try {
      const button = { closest: () => ({}) } as unknown as EventTarget;
      expect(send(touch("touchstart", 5, button)).defaultPrevented).toBe(false);
      expect(send(touch("touchstart", 150)).defaultPrevented).toBe(false);
      send(pointer("pointerdown", 150));
      send(pointer("pointerup", 150));
      expect(send(touch("touchend", 150)).defaultPrevented).toBe(false);
      expect(calls.opened).toBe(0);
    } finally {
      done();
    }
  });

  it("lets vertical scrolling through and closes an open drawer on a leftward drag", () => {
    const open = setup(true);
    try {
      open.send(pointer("pointerdown", 200, 300));
      open.send(pointer("pointermove", 205, 380)); // vertical: the drawer list scrolls
      expect(open.send(touch("touchmove", 205)).defaultPrevented).toBe(false);
      open.send(pointer("pointerup", 205, 380));

      open.send(pointer("pointerdown", 250));
      open.send(pointer("pointermove", 100));
      open.send(pointer("pointerup", 100));
      expect(open.calls.closed).toBe(1);
      open.detach();
    } finally {
      done();
    }
  });
});
