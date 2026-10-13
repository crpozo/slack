import { describe, expect, it } from "vitest";
import {
  CallActionSchema,
  CLIENT_ACTIONS,
  ClientActionSchema,
  channelSlug,
  ChannelNameSchema,
  isChannelMember,
  MAX_ATTACHMENT_SIZE,
  MAX_SDP_LENGTH,
  MAX_TEXT_LENGTH,
  MessageActionSchema,
  parseAction,
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
