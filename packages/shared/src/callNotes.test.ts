import { describe, expect, it } from "vitest";
import {
  foldMeetingTopic,
  MEETING_TOPIC_SUGGESTIONS,
  meetingTopicKey,
  SetMeetingTopicSchema,
} from "./callNotes";

describe("meeting topics (Phase 50)", () => {
  it("folds a topic however it's written, for the per-person index key", () => {
    expect(foldMeetingTopic("  Planificación   Q4 ")).toBe("planificacion q4");
    expect(foldMeetingTopic("Daily Sync")).toBe(foldMeetingTopic("daily  SYNC"));
    expect(meetingTopicKey("u-1", "Client Call")).toBe("u-1#client call");
  });

  it("takes a short topic, or null to clear it", () => {
    const base = { channelId: "dm#a#b", sk: "1#x" };
    expect(SetMeetingTopicSchema.parse({ ...base, topic: "  Client   Call " }).topic).toBe(
      "Client Call",
    );
    expect(SetMeetingTopicSchema.parse({ ...base, topic: null }).topic).toBeNull();
    expect(SetMeetingTopicSchema.safeParse({ ...base, topic: "" }).success).toBe(false);
    expect(SetMeetingTopicSchema.safeParse({ ...base, topic: "x".repeat(41) }).success).toBe(false);
    expect(SetMeetingTopicSchema.safeParse({ ...base, topic: "a\u0007b" }).success).toBe(false);
    expect(MEETING_TOPIC_SUGGESTIONS).toContain("Daily Sync");
  });
});
