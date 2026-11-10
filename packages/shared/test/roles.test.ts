import { describe, expect, it } from "vitest";
import {
  canEditChannel,
  canManageMembers,
  canRenameChannel,
  canSeeChannel,
  ChannelUpdateActionSchema,
  callLinkPath,
  cleanExternalName,
  EXTERNAL_ROUTES,
  externalMayReceive,
  guestMayReceive,
  GUEST_ROUTES,
  isRoomOp,
  roleFromGroups,
} from "../src";

describe("roles", () => {
  it("reads the id token's array and the HTTP authorizer's flattened claim", () => {
    expect(roleFromGroups(undefined)).toBe("member");
    expect(roleFromGroups([])).toBe("member");
    expect(roleFromGroups(["admins"])).toBe("admin");
    expect(roleFromGroups(["guests"])).toBe("guest");
    expect(roleFromGroups("[guests]")).toBe("guest");
    expect(roleFromGroups("[admins guests]")).toBe("guest"); // less access wins
    expect(roleFromGroups("[admins]")).toBe("admin");
  });

  it("lets guests receive their boards', channels' and channel calls' events, never presence or the calendar", () => {
    for (const type of [
      "board.task_created",
      "message.new",
      "channel.list",
      "user.typing",
      // Phase 59: their private channels' calls.
      "call.room",
      "call.rooms",
      "call.offer",
      "call.answer",
      "call.ice_candidate",
      "call.renegotiate",
    ]) {
      expect(guestMayReceive(type)).toBe(true);
    }
    for (const type of [
      "user.connected",
      "user.disconnected",
      "user.updated",
      "user.prefs",
      "calendar.event_created",
      // DM ringing and hanging up, and a call's shareable link: never.
      "call.end",
      "call.decline",
      "call.link",
      "call.lobby",
    ]) {
      expect(guestMayReceive(type)).toBe(false);
    }
    expect([...GUEST_ROUTES].sort()).toEqual([
      "call",
      "channel",
      "edit",
      "history",
      "message",
      "ping",
      "presign",
      "react",
      "read",
      "typing",
      "user",
    ]);
    expect(GUEST_ROUTES.has("pin")).toBe(false);
  });

  it("ties an external (a call link, no account) to their call: its signals and nothing else", () => {
    expect([...EXTERNAL_ROUTES].sort()).toEqual(["call", "ping"]);
    for (const type of [
      "call.room",
      "call.lobby",
      "call.offer",
      "call.answer",
      "call.ice_candidate",
      "call.renegotiate",
    ]) {
      expect(externalMayReceive(type)).toBe(true);
    }
    for (const type of [
      "message.new",
      "channel.list",
      "history.page",
      "user.list",
      "user.connected",
      "user.typing",
      "call.rooms",
      "call.link",
      "call.end",
      "board.updated",
      "calendar.event_created",
    ]) {
      expect(externalMayReceive(type), type).toBe(false);
    }
  });

  it("makes an external's name safe to show, and builds the link's path", () => {
    expect(cleanExternalName("  Ana   <b>Pérez</b>\u0000 ")).toBe("Ana bPérez/b");
    expect(cleanExternalName("x".repeat(80))).toHaveLength(40);
    expect(cleanExternalName("   ")).toBeNull();
    expect(cleanExternalName(42)).toBeNull();
    expect(callLinkPath("01JROOM", "a b/c")).toBe("/call/01JROOM?token=a%20b%2Fc");
  });

  it("treats link, knock and admit as room operations, not signals between two people", () => {
    const op = (signal: string) => isRoomOp({ action: "call", signal } as never);
    for (const s of ["join", "leave", "rooms", "link", "knock", "admit"]) expect(op(s)).toBe(true);
    for (const s of ["offer", "answer", "ice_candidates", "renegotiate", "end"])
      expect(op(s)).toBe(false);
  });

  it("shows an external only the private channels they were invited to (Phase 55)", () => {
    const pub = { type: "public" as const };
    const priv = { type: "private" as const, members: ["u1", "g1"] };
    const dm = { type: "dm" as const, members: ["g1", "u1"] };
    expect(canSeeChannel(pub, "g1", "guest")).toBe(false);
    expect(canSeeChannel(priv, "g1", "guest")).toBe(true);
    expect(canSeeChannel(priv, "g2", "guest")).toBe(false);
    expect(canSeeChannel(dm, "g1", "guest")).toBe(false);
    // Members as before.
    expect(canSeeChannel(pub, "u2", "member")).toBe(true);
    expect(canSeeChannel(pub, "u2", undefined)).toBe(true);
    expect(canSeeChannel(priv, "u2", "admin")).toBe(false);
  });

  it("lets a private channel's creator or an admin in it manage who's in it", () => {
    const priv = {
      channelId: "ch_x",
      type: "private" as const,
      createdBy: "u1",
      members: ["u1", "u2", "a1", "g1"],
    };
    expect(canManageMembers(priv, "u1", "member")).toBe(true);
    expect(canManageMembers(priv, "u2", "member")).toBe(false);
    expect(canManageMembers(priv, "a1", "admin")).toBe(true);
    expect(canManageMembers(priv, "a2", "admin")).toBe(false); // not in it
    expect(canManageMembers(priv, "g1", "guest")).toBe(false);
    expect(canManageMembers({ ...priv, createdBy: "g1" }, "g1", "guest")).toBe(false);
    expect(canManageMembers({ ...priv, type: "public" as const }, "u1", "admin")).toBe(false);
  });

  it("lets the creator or an admin rename a channel, never #general or a DM", () => {
    const ch = { channelId: "ch_x", type: "public" as const, createdBy: "u1" };
    expect(canRenameChannel(ch, "u1", "member")).toBe(true);
    expect(canRenameChannel(ch, "u2", "member")).toBe(false);
    expect(canRenameChannel(ch, "u2", "admin")).toBe(true);
    expect(canRenameChannel({ ...ch, channelId: "ch_general" }, "u1", "admin")).toBe(false);
    expect(canRenameChannel({ ...ch, type: "dm" as const }, "u1", "admin")).toBe(false);
    // Private: admins must be members too.
    const priv = { ...ch, type: "private" as const, members: ["u1"] };
    expect(canRenameChannel(priv, "u2", "admin")).toBe(false);
  });

  it("lets the creator or an admin edit a channel's details; #general only admins", () => {
    const ch = { channelId: "ch_x", type: "public" as const, createdBy: "u1" };
    expect(canEditChannel(ch, "u1", "member")).toBe(true);
    expect(canEditChannel(ch, "u2", "member")).toBe(false);
    expect(canEditChannel(ch, "u2", "admin")).toBe(true);
    const general = { ...ch, channelId: "ch_general", createdBy: "system" };
    expect(canEditChannel(general, "u1", "member")).toBe(false);
    expect(canEditChannel(general, "u1", "admin")).toBe(true);
    expect(canEditChannel({ ...ch, type: "dm" as const }, "u1", "admin")).toBe(false);
  });
});

describe("ChannelUpdateActionSchema", () => {
  const base = { action: "channel", op: "update", channelId: "ch_x" };
  it("takes any of name, topic and description; at least one", () => {
    expect(ChannelUpdateActionSchema.parse({ ...base, topic: "  Launch week  " }).topic).toBe(
      "Launch week",
    );
    expect(ChannelUpdateActionSchema.parse({ ...base, description: "a\nb" }).description).toBe(
      "a\nb",
    );
    expect(ChannelUpdateActionSchema.safeParse({ ...base, topic: "" }).success).toBe(true);
    expect(ChannelUpdateActionSchema.safeParse(base).success).toBe(false);
  });

  it("rejects control characters and over-long text", () => {
    expect(ChannelUpdateActionSchema.safeParse({ ...base, topic: "a\nb" }).success).toBe(false);
    expect(ChannelUpdateActionSchema.safeParse({ ...base, description: "a\u0007" }).success).toBe(
      false,
    );
    expect(ChannelUpdateActionSchema.safeParse({ ...base, topic: "x".repeat(121) }).success).toBe(
      false,
    );
  });
});
