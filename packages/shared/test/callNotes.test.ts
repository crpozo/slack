import { describe, expect, it } from "vitest";
import {
  aiNotesText,
  formatTranscript,
  MAX_TRANSCRIPT_CHARS,
  parseNotesPeerMessage,
  SummarizeCallSchema,
  transcriptClock,
} from "../src/callNotes";

const T0 = 1_760_000_000_000;

describe("AI call notes contract", () => {
  it("formats one time-ordered timeline from both sides", () => {
    const names: Record<string, string> = { a: "Carlos", b: "Ana" };
    expect(
      formatTranscript(
        [
          { userId: "b", text: "Sí, lo  reviso\nmañana.", at: T0 + 20_500 },
          { userId: "a", text: "¿Puedes revisar el contrato?", at: T0 + 12_000 },
          { userId: "a", text: "Gracias.", at: T0 + 3_725_000 },
        ],
        T0,
        (id) => names[id] ?? id,
      ),
    ).toBe(
      "[00:12] Carlos: ¿Puedes revisar el contrato?\n[00:20] Ana: Sí, lo reviso mañana.\n[1:02:05] Carlos: Gracias.",
    );
    expect(transcriptClock(T0 - 5_000, T0)).toBe("00:00");
  });

  it("validates a submission: limits, order of times, no empty phrases", () => {
    const ok = {
      callId: "c1",
      channelId: "dm_a_b",
      startedAt: T0,
      endedAt: T0 + 60_000,
      segments: [{ userId: "a", text: "hola", at: T0 + 1000 }],
    };
    expect(SummarizeCallSchema.safeParse(ok).success).toBe(true);
    expect(SummarizeCallSchema.safeParse({ ...ok, segments: [] }).success).toBe(false);
    expect(SummarizeCallSchema.safeParse({ ...ok, endedAt: T0 - 1 }).success).toBe(false);
    expect(
      SummarizeCallSchema.safeParse({ ...ok, segments: [{ userId: "a", text: "   ", at: T0 }] })
        .success,
    ).toBe(false);
    const long = Array.from({ length: 70 }, (_, i) => ({
      userId: "a",
      text: "x".repeat(1_999),
      at: T0 + i,
    }));
    expect(long.reduce((n, s) => n + s.text.length, 0)).toBeGreaterThan(MAX_TRANSCRIPT_CHARS);
    expect(SummarizeCallSchema.safeParse({ ...ok, segments: long }).success).toBe(false);
  });

  it("gives every state a plain-text fallback", () => {
    expect(aiNotesText({ status: "pending", summary: "" })).toBe("✨ AI call notes: generating…");
    expect(aiNotesText({ status: "failed", summary: "" })).toBe(
      "✨ AI call notes: couldn't be generated",
    );
    expect(
      aiNotesText({
        status: "ready",
        summary: "## Summary\n\n**Carlos** and Ana agreed to ship.\n- a",
      }),
    ).toBe("✨ AI call notes: Summary");
    expect(aiNotesText({ status: "ready", summary: "" })).toBe("✨ AI call notes");
  });

  it("parses only well-formed notes messages from the peer", () => {
    expect(parseNotesPeerMessage(JSON.stringify({ type: "notes", on: true, at: 5 }))).toEqual({
      type: "notes",
      on: true,
      at: 5,
    });
    expect(
      parseNotesPeerMessage(JSON.stringify({ type: "transcript", text: "  hola  ", at: 9 })),
    ).toEqual({ type: "transcript", text: "hola", at: 9 });
    // The media state the data channel also carries isn't a notes message.
    expect(
      parseNotesPeerMessage(JSON.stringify({ micOn: true, camOn: false, sharing: false })),
    ).toBeNull();
    expect(
      parseNotesPeerMessage(JSON.stringify({ type: "transcript", text: "", at: 1 })),
    ).toBeNull();
    expect(parseNotesPeerMessage(JSON.stringify({ type: "notes", on: "yes", at: 1 }))).toBeNull();
    expect(parseNotesPeerMessage("{nope")).toBeNull();
    expect(
      parseNotesPeerMessage(JSON.stringify({ type: "transcript", text: "x".repeat(3000), at: 1 })),
    ).toBeNull();
  });
});
