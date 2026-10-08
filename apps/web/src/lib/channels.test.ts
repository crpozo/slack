import { dmChannelId, type Channel } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import { channelLabel, dmEntries, formatDay, normalizeChannelName } from "./channels";
import { parseUsers } from "./config";

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

describe("normalizeChannelName", () => {
  it("turns free text into a valid channel name", () => {
    expect(normalizeChannelName("#Diseño Web 2026!")).toBe("diseno-web-2026");
    expect(normalizeChannelName("a".repeat(40))).toHaveLength(32);
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
    members: [me.userId, peer].sort(),
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
      { email: "ana@mt.ec", userId: "u-ana", channelId: undefined },
      { email: "bo@mt.ec", userId: "u-bo", channelId: dmChannelId(me.userId, "u-bo") },
      { email: "zed@mt.ec", userId: "u-zed", channelId: dmChannelId(me.userId, "u-zed") },
    ]);
  });

  it("labels DMs with the peer's email", () => {
    expect(
      channelLabel(dmChannelId("u-me", "u-bo"), undefined, "u-me", { "u-bo": "bo@mt.ec" }),
    ).toBe("bo@mt.ec");
    expect(channelLabel(dmChannelId("u-me", "u-x"), undefined, "u-me", {})).toBe("Mensaje directo");
  });
});

describe("formatDay", () => {
  it("says Hoy / Ayer for recent days", () => {
    const now = new Date(2026, 9, 8, 12).getTime();
    expect(formatDay(now - 1000, now)).toBe("Hoy");
    expect(formatDay(now - 86_400_000, now)).toBe("Ayer");
  });
});
