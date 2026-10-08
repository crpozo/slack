import { describe, expect, it } from "vitest";
import { dmChannelId, GENERAL_CHANNEL_ID, isDmChannel, newChannelId, newMessageSk } from "../src";

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
});
