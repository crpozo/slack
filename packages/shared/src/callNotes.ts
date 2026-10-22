import { z } from "zod";

// ---------------------------------------------------------------------------
// AI call notes (Phase 28). During a DM call with notes switched on, each
// side transcribes only its own voice (the browser's speech recognition) and
// shares each finished phrase with the other over the call's data channel,
// so both hold one timeline. When the call ends, the caller submits it; the
// server posts a pending ✨ card at once and a worker fills it with a
// summary and action items from Claude Haiku 5.5 on Amazon Bedrock.
// ---------------------------------------------------------------------------

/** One finished phrase: who said it and when they started (epoch ms). */
export interface TranscriptSegment {
  userId: string;
  text: string;
  at: number;
}

export type AiNotesStatus = "pending" | "ready" | "failed";

/** What an `ai_notes` message carries (see `Message.aiNotes`). */
export interface AiNotes {
  callId: string;
  status: AiNotesStatus;
  /** Markdown from the model; `""` until `ready`. */
  summary: string;
  /** Epoch ms: when the call connected and ended. */
  startedAt: number;
  endedAt: number;
  /** Both people of the DM, sorted. */
  participants: string[];
  /** `failed`: what to tell the reader. */
  error?: string;
}

/** The longest phrase accepted (one recognition result is a sentence or two). */
export const MAX_SEGMENT_CHARS = 2_000;
/** How many phrases one call may submit. */
export const MAX_SEGMENTS = 6_000;
/**
 * The most transcript text per call (roughly two hours of conversation). Kept
 * under the async Lambda payload limit with room to spare; a longer call is
 * refused, never silently cut.
 */
export const MAX_TRANSCRIPT_CHARS = 120_000;

export const TranscriptSegmentSchema = z.object({
  userId: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(MAX_SEGMENT_CHARS),
  at: z.number().int().nonnegative(),
});

export const SummarizeCallSchema = z
  .object({
    callId: z.string().min(1).max(64),
    channelId: z.string().min(1).max(256),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive(),
    segments: z.array(TranscriptSegmentSchema).min(1).max(MAX_SEGMENTS),
  })
  .refine((v) => v.endedAt >= v.startedAt, { message: "the call ends before it starts" })
  .refine((v) => v.segments.reduce((sum, s) => sum + s.text.length, 0) <= MAX_TRANSCRIPT_CHARS, {
    message: "the transcript is too long",
  });
export type SummarizeCallInput = z.infer<typeof SummarizeCallSchema>;

/** `[mm:ss]` (or `[h:mm:ss]`) since `startedAt`. */
export function transcriptClock(at: number, startedAt: number): string {
  const total = Math.max(0, Math.floor((at - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

/** The transcript as the model reads it: one `[mm:ss] Name: text` line per phrase, in time order. */
export function formatTranscript(
  segments: TranscriptSegment[],
  startedAt: number,
  nameOf: (userId: string) => string,
): string {
  return [...segments]
    .sort((a, b) => a.at - b.at)
    .map(
      (s) =>
        `[${transcriptClock(s.at, startedAt)}] ${nameOf(s.userId)}: ${s.text.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");
}

/** The plain-text fallback of a notes card (previews, pushes, older clients). */
export function aiNotesText(notes: Pick<AiNotes, "status" | "summary">): string {
  if (notes.status === "pending") return "✨ AI call notes: generating…";
  if (notes.status === "failed") return "✨ AI call notes: couldn't be generated";
  const firstLine =
    notes.summary
      .split("\n")
      .map((l) =>
        l
          .replace(/^[#>*\-\s]+/, "")
          .replace(/\*\*/g, "")
          .trim(),
      )
      .find((l) => l.length > 0) ?? "";
  const preview = firstLine.length > 140 ? `${firstLine.slice(0, 139).trimEnd()}…` : firstLine;
  return preview ? `✨ AI call notes: ${preview}` : "✨ AI call notes";
}

/**
 * What the two sides of a call send each other over the data channel about
 * notes (next to the media state, which older clients still parse alone).
 */
export type NotesPeerMessage =
  { type: "notes"; on: boolean; at: number } | { type: "transcript"; text: string; at: number };

/** Validates a notes message from the peer; anything else is `null`. */
export function parseNotesPeerMessage(data: unknown): NotesPeerMessage | null {
  if (typeof data !== "string" || data.length > MAX_SEGMENT_CHARS + 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  if (v.type === "notes" && typeof v.on === "boolean") return { type: "notes", on: v.on, at: v.at };
  if (v.type === "transcript" && typeof v.text === "string") {
    const text = v.text.trim();
    if (!text || text.length > MAX_SEGMENT_CHARS) return null;
    return { type: "transcript", text, at: v.at };
  }
  return null;
}
