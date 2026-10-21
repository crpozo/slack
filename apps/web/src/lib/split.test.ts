import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampSplit, loadSplit, saveSplit, SPLIT_DEFAULTS, splitAt } from "./split";

describe("the resizable pane's width", () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
    });
  });

  it("stays between 30% and 70%", () => {
    expect(clampSplit(10)).toBe(30);
    expect(clampSplit(90)).toBe(70);
    expect(clampSplit(42.345)).toBe(42.3);
    expect(clampSplit(Number.NaN)).toBe(50);
  });

  it("follows the pointer: the pane is what lies right of the divider", () => {
    const row = { left: 200, width: 1000 };
    expect(splitAt(700, row)).toBe(50);
    expect(splitAt(900, row)).toBe(30);
    expect(splitAt(1150, row)).toBe(30); // clamped
    expect(splitAt(400, row)).toBe(70);
    expect(splitAt(0, row)).toBe(70);
    expect(splitAt(500, { left: 0, width: 0 })).toBe(50);
  });

  it("is remembered per kind of pane, with sensible defaults", () => {
    expect(loadSplit("thread")).toBe(SPLIT_DEFAULTS.thread);
    expect(loadSplit("board")).toBe(SPLIT_DEFAULTS.board);
    saveSplit("board", 64);
    saveSplit("thread", 5);
    expect(loadSplit("board")).toBe(64);
    expect(loadSplit("thread")).toBe(30);
    stored["slack.split.board"] = "nonsense";
    expect(loadSplit("board")).toBe(SPLIT_DEFAULTS.board);
  });
});
