import { describe, expect, it } from "vitest";
import {
  canEditChannel,
  canRenameChannel,
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

  it("lets guests receive board events only, and call only board-related routes", () => {
    expect(guestMayReceive("board.task_created")).toBe(true);
    for (const type of [
      "message.new",
      "channel.list",
      "user.connected",
      "call.offer",
      "user.prefs",
    ]) {
      expect(guestMayReceive(type)).toBe(false);
    }
    expect([...GUEST_ROUTES].sort()).toEqual(["ping", "presign", "user"]);
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
