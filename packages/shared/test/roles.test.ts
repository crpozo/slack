import { describe, expect, it } from "vitest";
import { canRenameChannel, guestMayReceive, GUEST_ROUTES, roleFromGroups } from "../src";

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
});
