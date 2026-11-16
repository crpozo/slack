// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dmEntries } from "./channels";

describe("the DM list on load (Phase 66b)", () => {
  it("starts from the directory as it was last time, so a deleted account never flashes", async () => {
    const { useChat } = await import("../store");
    const me = { userId: "u-me", email: "me@mt.ec", role: "member" as const };
    const ana = { userId: "u-ana", email: "ana@mt.ec", displayName: "Ana", updatedAt: 0 };
    localStorage.setItem("slack.directory.u-me", JSON.stringify([ana]));
    // The build's list still has someone whose account is gone.
    useChat.getState().setSession(me, [{ userId: "u-ghost", email: "ghost@mt.ec" }]);
    const s = useChat.getState();
    expect(s.usersLoaded).toBe(true);
    const entries = dmEntries(
      s.team,
      [],
      me,
      s.directory,
      (id) => `dm_${id}`,
      s.users,
      s.usersLoaded,
    );
    expect(entries.map((e) => e.userId)).toEqual(["u-ana"]);
    // The next directory from the server replaces the remembered one.
    s.setUsers([ana, { userId: "u-bob", email: "bob@mt.ec", displayName: "Bob", updatedAt: 0 }]);
    expect(JSON.parse(localStorage.getItem("slack.directory.u-me") ?? "[]")).toHaveLength(2);
    localStorage.removeItem("slack.directory.u-me");
  });
});
