import { describe, expect, it } from "vitest";
import {
  CallActionSchema,
  CLIENT_ACTIONS,
  ClientActionSchema,
  canDeleteChannel,
  channelSlug,
  ChannelNameSchema,
  isChannelMember,
  isExpired,
  MAX_ATTACHMENT_SIZE,
  MAX_ICE_CANDIDATES_PER_SIGNAL,
  MAX_SDP_LENGTH,
  MAX_TEXT_LENGTH,
  MessageActionSchema,
  parseAction,
  readBy,
  slugifyChannelName,
} from "../src";

describe("protocol", () => {
  it("accepts every client action", () => {
    const actions = [
      { action: "message", channelId: "ch_general", text: "hola", clientId: "x" },
      { action: "history", channelId: "ch_general", cursor: "abc" },
      { action: "channel", op: "list" },
      { action: "channel", op: "create", name: "dev-team" },
      { action: "channel", op: "create", name: "Dev Team" },
      { action: "channel", op: "dm", withUserId: "user-1" },
      { action: "channel", op: "delete", channelId: "ch_x" },
      {
        action: "presign",
        op: "put",
        requestId: "r1",
        channelId: "ch_general",
        name: "foto.png",
        contentType: "image/png",
        size: 1024,
      },
      { action: "presign", op: "get", requestId: "r2", key: "attachments/ch_general/x-foto.png" },
      { action: "typing", channelId: "ch_general" },
    ];
    for (const action of actions) {
      expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
    }
  });

  it("enforces text, size and channel-name limits", () => {
    const tooLong = {
      action: "message",
      channelId: "c",
      text: "a".repeat(MAX_TEXT_LENGTH + 1),
      clientId: "x",
    };
    const tooBig = {
      action: "presign",
      op: "put",
      requestId: "r",
      channelId: "c",
      name: "big.bin",
      contentType: "application/octet-stream",
      size: MAX_ATTACHMENT_SIZE + 1,
    };
    const badName = { action: "channel", op: "create", name: "!!!" };
    for (const action of [tooLong, tooBig, badName]) {
      expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(false);
    }
  });

  it("parseAction rejects invalid JSON and schema mismatches", () => {
    expect(parseAction(MessageActionSchema, "{nope").success).toBe(false);
    expect(parseAction(MessageActionSchema, undefined).success).toBe(false);
    expect(parseAction(MessageActionSchema, JSON.stringify({ action: "message" })).success).toBe(
      false,
    );

    const ok = parseAction(
      MessageActionSchema,
      JSON.stringify({ action: "message", channelId: "c", text: "hola", clientId: "x" }),
    );
    expect(ok).toEqual({
      success: true,
      data: { action: "message", channelId: "c", text: "hola", clientId: "x" },
    });
  });
});

describe("phase 5.1 contract", () => {
  it("creates private channels by default", () => {
    const parsed = ClientActionSchema.parse({ action: "channel", op: "create", name: "equipo" });
    expect(parsed).toMatchObject({ visibility: "private" });
  });

  it("validates invites, display names and reactions", () => {
    const ok = [
      { action: "channel", op: "invite", channelId: "ch_x", userIds: ["user-1"] },
      { action: "user", op: "list" },
      { action: "user", op: "update", displayName: "Carlos 🚀" },
      { action: "react", channelId: "ch_x", sk: "1#A", emoji: "👨‍👩‍👧", op: "add" },
      { action: "react", channelId: "ch_x", sk: "1#A", emoji: ":+1:", op: "remove" },
    ];
    for (const action of ok) {
      expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
    }
    const bad = [
      { action: "channel", op: "invite", channelId: "ch_x", userIds: [] },
      { action: "channel", op: "invite", channelId: "ch_x", userIds: ["a_b"] },
      { action: "user", op: "update", displayName: "" },
      { action: "user", op: "update", displayName: "x".repeat(41) },
      { action: "react", channelId: "ch_x", sk: "1#A", emoji: "👍", op: "toggle" },
      { action: "react", channelId: "ch_x", sk: "1#A", emoji: "a b", op: "add" },
    ];
    for (const action of bad) {
      expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(false);
    }
  });

  it("isChannelMember: public is open, private and dm need membership", () => {
    expect(isChannelMember({ type: "public" }, "u1")).toBe(true);
    expect(isChannelMember({ type: "private", members: ["u1"] }, "u1")).toBe(true);
    expect(isChannelMember({ type: "private", members: ["u1"] }, "u2")).toBe(false);
    expect(isChannelMember({ type: "dm" }, "u1")).toBe(false);
  });

  it("routes the new actions", () => {
    expect(CLIENT_ACTIONS).toEqual(expect.arrayContaining(["user", "react"]));
  });

  describe("call signaling", () => {
    const base = { action: "call", callId: "c1", channelId: "dm_u1_u2", to: "u2" } as const;

    it("accepts every signal and fills the defaults", () => {
      const signals = [
        { ...base, signal: "offer", media: "video", sdp: "v=0" },
        { ...base, signal: "answer", sdp: "v=0" },
        {
          ...base,
          signal: "ice_candidate",
          candidate: {
            candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        },
        { ...base, signal: "ice_candidate", candidate: { candidate: "" } }, // end of candidates
        {
          ...base,
          signal: "ice_candidates",
          candidates: [{ candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0" }],
        },
        { ...base, signal: "end", reason: "no_answer" },
        { ...base, signal: "decline", reason: "busy" },
      ];
      for (const action of signals) {
        expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
      }
      expect(CallActionSchema.parse({ ...base, signal: "end" })).toMatchObject({
        reason: "hangup",
      });
      expect(CallActionSchema.parse({ ...base, signal: "decline" })).toMatchObject({
        reason: "declined",
      });
    });

    it("rejects oversized SDP, unknown signals and invalid recipients", () => {
      const bad = [
        { ...base, signal: "offer", media: "video", sdp: "x".repeat(MAX_SDP_LENGTH + 1) },
        { ...base, signal: "offer", media: "screen", sdp: "v=0" },
        { ...base, signal: "answer", sdp: "" },
        { ...base, signal: "ring" },
        { ...base, signal: "end", reason: "whatever" },
        { ...base, signal: "decline", reason: "no_answer" },
        { ...base, to: "u_2", signal: "end" },
        { ...base, callId: "", signal: "end" },
        { ...base, signal: "ice_candidates", candidates: [] },
        {
          ...base,
          signal: "ice_candidates",
          candidates: Array.from({ length: MAX_ICE_CANDIDATES_PER_SIGNAL + 1 }, () => ({
            candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
          })),
        },
      ];
      for (const action of bad) {
        expect(CallActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(false);
      }
    });

    it("is routed as its own action", () => {
      expect(CLIENT_ACTIONS).toContain("call");
    });
  });

  describe("ping", () => {
    it("is a bare heartbeat frame with its own route", () => {
      expect(ClientActionSchema.safeParse({ action: "ping" }).success).toBe(true);
      expect(ClientActionSchema.safeParse({ action: "ping", extra: 1 }).success).toBe(true);
      expect(CLIENT_ACTIONS).toContain("ping");
    });
  });
});

describe("channel names", () => {
  it("slugifies readable names", () => {
    expect(slugifyChannelName("Web Design")).toBe("web-design");
    expect(slugifyChannelName("  #Diseño   Web!  ")).toBe("diseno-web");
    expect(slugifyChannelName("a -- b__c")).toBe("a-b-c");
    expect(slugifyChannelName("--x--")).toBe("x");
    expect(slugifyChannelName("!!!")).toBe("");
    expect(slugifyChannelName("a".repeat(31) + " b")).toBe("a".repeat(31));
  });

  it("stays linear on long runs of separators (no regex backtracking)", () => {
    const evil = "-".repeat(100_000) + "a" + "-".repeat(100_000) + "!";
    const started = performance.now();
    expect(slugifyChannelName(evil)).toBe("a");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("uses the stored slug, else derives it from legacy slug-shaped names", () => {
    expect(channelSlug({ name: "Web Design", slug: "web-design" })).toBe("web-design");
    expect(channelSlug({ name: "dev-team" })).toBe("dev-team");
  });

  it("accepts readable names and trims them", () => {
    expect(ChannelNameSchema.parse("  Q4 Launch 🚀 ")).toBe("Q4 Launch 🚀");
    for (const bad of ["", "   ", "🚀", "a\u0000b", "x".repeat(41)]) {
      expect(ChannelNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("canDeleteChannel", () => {
  const base = {
    channelId: "ch_x",
    type: "public" as const,
    slug: "x",
    createdBy: "u-a",
  };
  it("lets the creator delete, and others only for legacy or orphaned channels", () => {
    expect(canDeleteChannel(base, "u-a", true)).toBe(true);
    expect(canDeleteChannel(base, "u-b", true)).toBe(false);
    expect(canDeleteChannel({ ...base, slug: undefined }, "u-b", true)).toBe(true);
    expect(canDeleteChannel({ ...base, createdBy: " " }, "u-b", true)).toBe(true);
    expect(canDeleteChannel(base, "u-b", false)).toBe(true);
  });
  it("never allows #general or non-members", () => {
    expect(
      canDeleteChannel({ ...base, channelId: "ch_general", slug: undefined }, "u-a", false),
    ).toBe(false);
    const priv = { ...base, type: "private" as const, slug: undefined, members: ["u-a"] };
    expect(canDeleteChannel(priv, "u-b", false)).toBe(false);
    expect(canDeleteChannel({ ...priv, members: ["u-a", "u-b"] }, "u-b", true)).toBe(true);
  });
  it("lets either member delete a DM", () => {
    const dm = {
      channelId: "dm_u-a_u-b",
      type: "dm" as const,
      createdBy: "u-a",
      members: ["u-a", "u-b"],
    };
    expect(canDeleteChannel(dm, "u-b", true)).toBe(true);
  });
});

describe("phase 10: read marks, edits, typing", () => {
  const msg = { sk: "1700000000500#01B", userId: "u-a" };

  it("derives readBy from the channel's watermarks (sort keys order by time)", () => {
    expect(readBy(msg, undefined)).toEqual([]);
    expect(
      readBy(msg, {
        "u-a": { sk: "1700000000900#01Z", at: 1 }, // the author never counts
        "u-b": { sk: "1700000000500#01B", at: 1 }, // exactly this message
        "u-c": { sk: "1700000000400#01A", at: 1 }, // an older one: not yet
        "u-d": { sk: "1700000000900#01Z", at: 1 },
      }),
    ).toEqual(["u-b", "u-d"]);
  });

  it("routes read, edit and typing as WebSocket actions", () => {
    expect(CLIENT_ACTIONS).toEqual(expect.arrayContaining(["read", "edit", "typing"]));
    const parse = (action: object) => parseAction(ClientActionSchema, JSON.stringify(action));
    expect(parse({ action: "read", channelId: "ch_x", sk: "1#a" })).toMatchObject({
      success: true,
    });
    const edit = parse({ action: "edit", channelId: "ch_x", sk: "1#a", text: "  fixed  " });
    expect(edit).toMatchObject({ success: true, data: { text: "fixed" } });
    expect(parse({ action: "edit", channelId: "ch_x", sk: "1#a", text: "  " })).toMatchObject({
      success: false,
    });
  });
});

describe("secret messages", () => {
  it("accept isSecret on a send", () => {
    const sent = parseAction(
      ClientActionSchema,
      JSON.stringify({
        action: "message",
        channelId: "ch_x",
        text: "pw",
        clientId: "c",
        isSecret: true,
      }),
    );
    expect(sent).toMatchObject({ success: true, data: { isSecret: true } });
  });

  it("count as expired as soon as their TTL (epoch seconds) passes", () => {
    const now = 1_700_000_000_000;
    expect(isExpired({ expiresAt: now / 1000 + 1 }, now)).toBe(false);
    expect(isExpired({ expiresAt: now / 1000 }, now)).toBe(true);
    expect(isExpired({}, now)).toBe(false);
  });
});

describe("project channels", () => {
  const parse = (action: object) => parseAction(ClientActionSchema, JSON.stringify(action));
  it("create and update carry the project flag and the board choice", () => {
    expect(
      parse({
        action: "channel",
        op: "create",
        name: "Launch",
        isProject: true,
        board: { mode: "create" },
      }),
    ).toMatchObject({ success: true, data: { isProject: true, board: { mode: "create" } } });
    expect(parse({ action: "channel", op: "create", name: "Launch" })).toMatchObject({
      success: true,
      data: { isProject: false },
    });
    expect(
      parse({
        action: "channel",
        op: "update",
        channelId: "ch_x",
        board: { mode: "link", boardId: "b_1" },
      }),
    ).toMatchObject({ success: true });
    expect(
      parse({ action: "channel", op: "update", channelId: "ch_x", isProject: false }),
    ).toMatchObject({
      success: true,
    });
    expect(
      parse({ action: "channel", op: "update", channelId: "ch_x", board: { mode: "nope" } }),
    ).toMatchObject({
      success: false,
    });
  });
});
