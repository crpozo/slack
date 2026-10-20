import { dmChannelId, type Channel, compareIds } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  channelLabel,
  dmEntries,
  type DmEntry,
  formatDay,
  orderChannels,
  orderDms,
} from "./channels";
import { parseUsers, resolveConfig } from "./config";

const me = { userId: "u-me", email: "me@mt.ec" };

describe("parseUsers", () => {
  it("parses email and email=sub entries, ignoring placeholders", () => {
    expect(parseUsers(" A@mt.ec=u-a , b@mt.ec, c@mt.ec=<cognito-sub>, nope ")).toEqual([
      { email: "a@mt.ec", userId: "u-a" },
      { email: "b@mt.ec", userId: undefined },
      { email: "c@mt.ec", userId: undefined },
    ]);
  });
});

describe("dmEntries", () => {
  const dm = (peer: string): Channel => ({
    channelId: dmChannelId(me.userId, peer),
    name: "dm",
    type: "dm",
    createdBy: me.userId,
    createdAt: 1,
    archived: false,
    members: [me.userId, peer].sort(compareIds),
  });

  it("lists teammates (not me), resolves ids from the directory and links existing DMs", () => {
    const entries = dmEntries(
      [
        { email: "me@mt.ec", userId: "u-me" },
        { email: "ana@mt.ec" },
        { email: "bo@mt.ec", userId: "u-bo" },
      ],
      [dm("u-bo"), dm("u-zed")],
      me,
      { "u-ana": "ana@mt.ec", "u-zed": "zed@mt.ec" },
      (id) => dmChannelId(me.userId, id),
    );
    expect(entries).toEqual([
      { email: "ana@mt.ec", name: "ana", userId: "u-ana", channelId: undefined },
      { email: "bo@mt.ec", name: "bo", userId: "u-bo", channelId: dmChannelId(me.userId, "u-bo") },
      {
        email: "zed@mt.ec",
        name: "zed",
        userId: "u-zed",
        channelId: dmChannelId(me.userId, "u-zed"),
      },
    ]);
  });

  it("lists the server directory by display name, without duplicates", () => {
    const profile = (userId: string, email: string, displayName: string) => ({
      userId,
      email,
      displayName,
      updatedAt: 1,
    });
    const entries = dmEntries(
      [{ email: "bo@mt.ec", userId: "u-bo" }],
      [],
      me,
      {},
      (id) => dmChannelId(me.userId, id),
      {
        "u-me": profile("u-me", "me@mt.ec", "Yo"),
        "u-bo": profile("u-bo", "bo@mt.ec", "Zoe"),
        "u-al": profile("u-al", "al@mt.ec", "Alba"),
      },
    );
    expect(entries.map((e) => [e.userId, e.name])).toEqual([
      ["u-al", "Alba"],
      ["u-bo", "Zoe"],
    ]);
  });

  it("labels DMs with the peer's display name", () => {
    expect(
      channelLabel(dmChannelId("u-me", "u-bo"), undefined, "u-me", (id) =>
        id === "u-bo" ? "Bo" : undefined,
      ),
    ).toBe("Bo");
    expect(channelLabel(dmChannelId("u-me", "u-x"), undefined, "u-me", () => undefined)).toBe(
      "Direct message",
    );
  });
});

describe("formatDay", () => {
  it("says Today / Yesterday for recent days", () => {
    const now = new Date(2026, 9, 8, 12).getTime();
    expect(formatDay(now - 1000, now)).toBe("Today");
    expect(formatDay(now - 86_400_000, now)).toBe("Yesterday");
  });
});

describe("resolveConfig", () => {
  const env = {
    VITE_WS_URL: "wss://local",
    VITE_COGNITO_USER_POOL_ID: "pool-local",
    VITE_COGNITO_CLIENT_ID: "client-local",
    VITE_USERS: "a@mt.ec=u-a",
  };

  it("uses the deployed config.json over build-time env", () => {
    expect(
      resolveConfig(
        { wsUrl: "wss://deployed", userPoolId: "pool", userPoolClientId: "client" },
        env,
      ),
    ).toEqual({
      wsUrl: "wss://deployed/",
      userPoolId: "pool",
      userPoolClientId: "client",
      users: [{ email: "a@mt.ec", userId: "u-a" }],
    });
  });

  it("falls back to VITE_* in local dev and lets config.json set users", () => {
    expect(resolveConfig(null, env).wsUrl).toBe("wss://local/");
    expect(resolveConfig({ users: "b@mt.ec=u-b" }, env).users).toEqual([
      { email: "b@mt.ec", userId: "u-b" },
    ]);
  });

  it("rejects an insecure WebSocket URL", () => {
    expect(() => resolveConfig({ wsUrl: "ws://evil.example" }, env)).toThrow("wss://");
  });

  it("names every missing value", () => {
    expect(() => resolveConfig({ wsUrl: "" }, {})).toThrow(
      "VITE_WS_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID",
    );
  });
});

describe("guests in the DM list", () => {
  it("never lists a guest, even one in the directory", () => {
    const me = { userId: "u-me", email: "me@mt.ec" };
    const entries = dmEntries([], [], me, {}, (id) => `dm_${id}`, {
      "u-ana": { userId: "u-ana", email: "ana@mt.ec", displayName: "Ana", updatedAt: 0 },
      "u-guest": {
        userId: "u-guest",
        email: "client@acme.com",
        displayName: "Client",
        updatedAt: 0,
        role: "guest",
      },
    });
    expect(entries.map((e) => e.userId)).toEqual(["u-ana"]);
  });
});

describe("seenByLine", () => {
  it("names up to three readers, then counts the rest", async () => {
    const { seenByLine } = await import("./channels");
    expect(seenByLine([])).toBe("");
    expect(seenByLine(["Ana"])).toBe("Seen by Ana");
    expect(seenByLine(["Ana", "Luis"])).toBe("Seen by Ana and Luis");
    expect(seenByLine(["Ana", "Luis", "Eva"])).toBe("Seen by Ana, Luis and Eva");
    expect(seenByLine(["Ana", "Luis", "Eva", "Max", "Zoe"])).toBe("Seen by Ana, Luis and 3 others");
  });
});

describe("pinnedFirst", () => {
  it("puts pinned conversations on top in pin order and keeps the rest's order", async () => {
    const { pinnedFirst } = await import("./channels");
    const entries = [
      { name: "Ana", channelId: "dm_a" },
      { name: "Bo", channelId: "dm_b" },
      { name: "Cy" },
      { name: "Di", channelId: "dm_d" },
    ];
    expect(pinnedFirst(entries, ["dm_d", "dm_b"]).map((e) => e.name)).toEqual([
      "Di",
      "Bo",
      "Ana",
      "Cy",
    ]);
    expect(pinnedFirst(entries, [])).toEqual(entries);
  });
});

describe("priority chats", () => {
  const ch = (channelId: string, extra: Partial<Channel> = {}): Channel => ({
    channelId,
    name: channelId,
    type: "public",
    createdBy: "u-a",
    createdAt: 10,
    archived: false,
    ...extra,
  });

  it("orders channels by their latest message, #general always first", () => {
    const ordered = orderChannels([
      ch("quiet", { createdAt: 5 }),
      ch("design", { lastMessageAt: 200 }),
      ch("ch_general", { name: "general", lastMessageAt: 50 }),
      ch("random", { lastMessageAt: 300 }),
      ch("newer-quiet", { createdAt: 8 }),
    ]);
    expect(ordered.map((c) => c.channelId)).toEqual([
      "ch_general",
      "random",
      "design",
      "newer-quiet",
      "quiet",
    ]);
  });

  it("orders DMs: pinned, then by activity, then people never written to", () => {
    const entries: DmEntry[] = [
      { email: "ana@x", name: "Ana", userId: "ana", channelId: "dm_ana" },
      { email: "bob@x", name: "Bob", userId: "bob", channelId: "dm_bob" },
      { email: "cy@x", name: "Cy", userId: "cy" },
      { email: "dan@x", name: "Dan", userId: "dan", channelId: "dm_dan" },
    ];
    const channels = [
      ch("dm_ana", { type: "dm", lastMessageAt: 100 }),
      ch("dm_bob", { type: "dm", lastMessageAt: 900 }),
      ch("dm_dan", { type: "dm", lastMessageAt: 500 }),
    ];
    expect(orderDms(entries, channels, ["dm_ana"]).map((e) => e.name)).toEqual([
      "Ana",
      "Bob",
      "Dan",
      "Cy",
    ]);
    expect(orderDms(entries, channels, []).map((e) => e.name)).toEqual(["Bob", "Dan", "Ana", "Cy"]);
  });
});
