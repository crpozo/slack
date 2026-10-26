import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRecents, loadRecents, MAX_RECENTS, pushRecent, recordVisit } from "./recents";

describe("recents", () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    });
  });

  it("puts the last visit on top without duplicates, keeping 15", () => {
    let list = pushRecent([], "a", 1);
    list = pushRecent(list, "b", 2);
    list = pushRecent(list, "a", 3);
    expect(list.map((r) => r.channelId)).toEqual(["a", "b"]);
    for (let i = 0; i < 30; i++) list = pushRecent(list, `c${i}`, 10 + i);
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]?.channelId).toBe("c29");
  });

  it("is stored per account on this device, and forgotten on sign-out", () => {
    recordVisit("me", "ch_general", 1);
    recordVisit("me", "ch_proj", 2);
    recordVisit("other", "ch_x", 3);
    expect(loadRecents("me").map((r) => r.channelId)).toEqual(["ch_proj", "ch_general"]);
    forgetRecents("me");
    expect(loadRecents("me")).toEqual([]);
    expect(loadRecents("other")).toHaveLength(1);
  });

  it("ignores junk in storage", () => {
    localStorage.setItem("slack.recents.me", '[{"channelId":1},"x",{"channelId":"ok","at":1}]');
    expect(loadRecents("me")).toEqual([{ channelId: "ok", at: 1 }]);
    localStorage.setItem("slack.recents.me", "{not json");
    expect(loadRecents("me")).toEqual([]);
  });
});
