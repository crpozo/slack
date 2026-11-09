import { describe, expect, it } from "vitest";
import {
  canEditChannel,
  canManageMembers,
  canRenameChannel,
  canSeeChannel,
  ChannelUpdateActionSchema,
  guestMayReceive,
  GUEST_ROUTES,
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

  it("lets guests receive their boards' and channels' events, never presence, calls or the calendar", () => {
    for (const type of ["board.task_created", "message.new", "channel.list", "user.typing"]) {
      expect(guestMayReceive(type)).toBe(true);
    }
    for (const type of [
      "user.connected",
      "user.disconnected",
      "user.updated",
      "call.offer",
      "call.room",
      "user.prefs",
      "calendar.event_created",
    ]) {
      expect(guestMayReceive(type)).toBe(false);
    }
    expect([...GUEST_ROUTES].sort()).toEqual([
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
    expect(GUEST_ROUTES.has("call")).toBe(false);
    expect(GUEST_ROUTES.has("pin")).toBe(false);
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
