import { describe, expect, it } from "vitest";
import {
  canAccessChannel,
  dmChannelId,
  dmMembers,
  GENERAL_CHANNEL_ID,
  isDmChannel,
  newChannelId,
  newMessageSk,
} from "../src";

describe("ids", () => {
  it("exposes the fixed #general id", () => {
    expect(GENERAL_CHANNEL_ID).toBe("ch_general");
  });

  it("builds the same DM id regardless of argument order", () => {
    expect(dmChannelId("bob", "alice")).toBe("dm_alice_bob");
    expect(dmChannelId("alice", "bob")).toBe("dm_alice_bob");
  });

  it("detects DM channels", () => {
    expect(isDmChannel(dmChannelId("a", "b"))).toBe(true);
    expect(isDmChannel(GENERAL_CHANNEL_ID)).toBe(false);
    expect(isDmChannel(newChannelId())).toBe(false);
  });

  it("builds message sort keys that sort chronologically", () => {
    const earlier = newMessageSk(1_700_000_000_000);
    const later = newMessageSk(1_700_000_000_001);
    expect(earlier).toMatch(/^1700000000000#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(earlier < later).toBe(true);
  });

  it("extracts DM members and checks channel access", () => {
    const dm = dmChannelId("user-b", "user-a");
    expect(dmMembers(dm)).toEqual(["user-a", "user-b"]);
    expect(dmMembers(GENERAL_CHANNEL_ID)).toBeNull();
    expect(canAccessChannel(dm, "user-a")).toBe(true);
    expect(canAccessChannel(dm, "user-c")).toBe(false);
    expect(canAccessChannel("dm_malformed", "malformed")).toBe(false);
    expect(canAccessChannel(GENERAL_CHANNEL_ID, "anyone")).toBe(true);
  });
});
