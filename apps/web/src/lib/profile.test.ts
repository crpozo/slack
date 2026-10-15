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

const me = { userId: "u-me", email: "carlos@mindfultech.ec", role: "member" as const };
const profile = { userId: "u-me", email: me.email, displayName: "Carlos Pozo", updatedAt: 1 };

describe("own profile cache", () => {
  it("shows your display name from the first frame after a reload, not your email prefix", async () => {
    let { useChat, selectName } = await import("../store");
    useChat.getState().setSession(me);
    useChat.getState().setUsers([profile]);

    vi.resetModules(); // a fresh start (app relaunch), before any directory arrives
    ({ useChat, selectName } = await import("../store"));
    useChat.getState().setSession(me);
    expect(selectName(useChat.getState(), me.userId)).toBe("Carlos Pozo");
  });

  it("follows a rename made on another device", async () => {
    const { useChat } = await import("../store");
    const { loadOwnProfile } = await import("./profile");
    useChat.getState().setSession(me);
    useChat.getState().upsertUser({ ...profile, displayName: "Carlos" });
    expect(loadOwnProfile(me.userId)?.displayName).toBe("Carlos");
    expect(loadOwnProfile("someone-else")).toBeNull();
  });
});
