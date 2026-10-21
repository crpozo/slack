import { beforeEach, describe, expect, it, vi } from "vitest";

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
  vi.resetModules();
});

const alert = (title: string) =>
  ({ kind: "task", title, body: "b", url: "/app/tasks/b_1" }) as const;

describe("notifications (the bell)", () => {
  it("keeps the newest first, counts unread, and saves per user", async () => {
    const { useNotifications } = await import("./notifications");
    const s = () => useNotifications.getState();
    s().load("u1");
    s().add(alert("first"));
    s().add(alert("second"), true); // already seen
    expect(s().alerts.map((a) => [a.title, a.read])).toEqual([
      ["second", true],
      ["first", false],
    ]);

    vi.resetModules();
    const again = (await import("./notifications")).useNotifications;
    again.getState().load("u1");
    expect(again.getState().alerts).toHaveLength(2);
    again.getState().load("u2"); // someone else on this device sees none of it
    expect(again.getState().alerts).toEqual([]);
  });

  it("marks all read, clears, and caps the list", async () => {
    const { useNotifications, MAX_ALERTS } = await import("./notifications");
    const s = () => useNotifications.getState();
    s().load("u1");
    for (let i = 0; i < MAX_ALERTS + 5; i++) s().add(alert(`a${i}`));
    expect(s().alerts).toHaveLength(MAX_ALERTS);
    expect(s().alerts[0]?.title).toBe(`a${MAX_ALERTS + 4}`);
    s().markAllRead();
    expect(s().alerts.every((a) => a.read)).toBe(true);
    s().clear();
    expect(s().alerts).toEqual([]);
    expect(store["slack.alerts.u1"]).toBe("[]");
  });

  it("reading a conversation clears its message alerts only, older saved ones by url", async () => {
    const { useNotifications } = await import("./notifications");
    const s = () => useNotifications.getState();
    s().load("u1");
    const msg = (title: string, channelId: string, withId = true) =>
      ({
        kind: "message",
        title,
        body: "b",
        url: `/app/${channelId}`,
        ...(withId && { channelId }),
      }) as const;
    s().add(msg("ana 1", "dm_ana_me"));
    s().add(msg("ana old", "dm_ana_me", false)); // saved before channelId existed
    s().add(msg("design", "ch_design"));
    s().add(alert("task"));
    const before = s().alerts;
    s().markChannelRead("dm_ana_me");
    expect(s().alerts.map((a) => [a.title, a.read])).toEqual([
      ["task", false],
      ["design", false],
      ["ana old", true],
      ["ana 1", true],
    ]);
    expect(JSON.parse(store["slack.alerts.u1"] ?? "[]")[2].read).toBe(true);
    // Nothing left to clear: no new list, no write.
    const after = s().alerts;
    s().markChannelRead("dm_ana_me");
    expect(s().alerts).toBe(after);
    expect(after).not.toBe(before);
  });

  it("survives corrupt or missing storage", async () => {
    store["slack.alerts.u1"] = "{nope";
    const { useNotifications } = await import("./notifications");
    useNotifications.getState().load("u1");
    expect(useNotifications.getState().alerts).toEqual([]);
  });
});
