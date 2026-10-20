import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardPaneStore } from "./boardPane";

describe("board pane", () => {
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

  it("remembers which project channels show their board, on this device", () => {
    const store = createBoardPaneStore();
    expect(store.getState().open).toEqual({});
    store.getState().setOpen("ch_launch", true);
    expect(JSON.parse(stored["slack.boardPane.open"] ?? "{}")).toEqual({ ch_launch: true });

    const again = createBoardPaneStore();
    expect(again.getState().open).toEqual({ ch_launch: true });
    again.getState().setOpen("ch_launch", false);
    expect(again.getState().open).toEqual({});
    expect(JSON.parse(stored["slack.boardPane.open"] ?? "{}")).toEqual({});
  });

  it("ignores anything but true in what it reads back", () => {
    stored["slack.boardPane.open"] = JSON.stringify({ a: true, b: "yes", c: false });
    expect(createBoardPaneStore().getState().open).toEqual({ a: true });
    stored["slack.boardPane.open"] = "not json";
    expect(createBoardPaneStore().getState().open).toEqual({});
  });
});
