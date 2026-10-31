import { z } from "zod";
import { MAX_ATTACHMENT_SIZE } from "./protocol";

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

// ---------------------------------------------------------------------------
// Phase 46: every notes card is filed under one category and a few topics,
// decided by the model from the summary, so the AI Notes hub can be browsed
// by what the calls were about, not only by date and person.
// ---------------------------------------------------------------------------

export const NOTES_CATEGORIES = [
  "client",
  "project",
  "planning",
  "sales",
  "support",
  "technical",
  "team",
  "other",
] as const;
export type NotesCategory = (typeof NOTES_CATEGORIES)[number];

/** How each category reads in the app. */
export const NOTES_CATEGORY_LABELS: Record<NotesCategory, string> = {
  client: "Client",
  project: "Project",
  planning: "Planning",
  sales: "Sales",
  support: "Support",
  technical: "Technical",
  team: "Team",
  other: "Other",
};

/** What each category means (the model reads this; the app shows it as a hint). */
export const NOTES_CATEGORY_HINTS: Record<NotesCategory, string> = {
  client: "a meeting with or about a client: requirements, feedback, demos, deliveries",
  project: "progress on a project the team is building: status, blockers, next steps",
  planning: "planning and priorities: roadmaps, estimates, scheduling, scope",
  sales: "a prospect, a proposal, pricing or a negotiation",
  support: "an incident, a bug report or helping someone use a product",
  technical: "architecture, code, infrastructure or tooling decisions",
  team: "the team itself: hiring, onboarding, process, one-on-ones, admin",
  other: "anything else",
};

export const isNotesCategory = (value: unknown): value is NotesCategory =>
  NOTES_CATEGORIES.includes(value as NotesCategory);

/** At most this many topics per card, each at most `MAX_NOTE_TOPIC_LENGTH` characters. */
export const MAX_NOTE_TOPICS = 6;
export const MAX_NOTE_TOPIC_LENGTH = 40;

/** What the model files a card under. */
export interface NotesMeta {
  category: NotesCategory;
  /** Short tags in the call's language ("Facturación", "Migración a AWS"). */
  topics: string[];
}

/** `POST /notes/classify`: cards filed this time, and how many of yours still wait. */
export interface ClassifyNotesResponse {
  classified: number;
  remaining: number;
}

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
  /** Its action items were added to a board (Phase 29): once per notes card. */
  sentToBoard?: NotesSentToBoard;
  /** Phase 46: what the call was about. Cards from before are filed on request. */
  category?: NotesCategory;
  topics?: string[];
  /**
   * Phase 40: the full notes are kept apart (`GET /notes/{callId}`): the raw
   * transcript, the polished minutes and your own questions. Cards from before
   * Phase 40 have none.
   */
  details?: true;
  /** Phase 40: the call's recording (both voices, while notes were on). */
  audio?: NoteAudio;
}

/** A call's recording, uploaded like any attachment under the conversation's folder. */
export interface NoteAudio {
  key: string;
  contentType: string;
  size: number;
  durationMs: number;
}

export interface NotesSentToBoard {
  boardId: string;
  /** As it was named then (the card shows it without loading the board). */
  boardName: string;
  /** How many tasks were created. */
  count: number;
  /** Who sent them, and when (epoch ms). */
  by: string;
  at: number;
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
    /**
     * Phase 28–40: the phrases each browser heard. From Phase 43 the clips
     * transcribed by Whisper during the call (`source: "whisper"`) replace
     * them; still accepted from apps opened before.
     */
    segments: z.array(TranscriptSegmentSchema).min(1).max(MAX_SEGMENTS).optional(),
    /** Phase 43: the transcript is the call's clips, already transcribed by Whisper. */
    source: z.literal("whisper").optional(),
    /**
     * Phase 43: someone in the call chose "Guardar audio original como
     * respaldo". Without it the recording is never stored (and the server
     * refuses one for these notes).
     */
    keepAudio: z.boolean().optional(),
  })
  .refine((v) => v.endedAt >= v.startedAt, { message: "the call ends before it starts" })
  .refine((v) => (v.source === "whisper") !== (v.segments !== undefined), {
    message: "send either the transcript segments or source: whisper",
  })
  .refine(
    (v) => (v.segments ?? []).reduce((sum, s) => sum + s.text.length, 0) <= MAX_TRANSCRIPT_CHARS,
    { message: "the transcript is too long" },
  );
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
 * `transcript` comes from apps before Phase 43 (each side transcribed its own
 * voice); `backup` is Phase 43's "save the original audio" switch.
 */
export type NotesPeerMessage =
  | { type: "notes"; on: boolean; at: number }
  | { type: "transcript"; text: string; at: number }
  | { type: "backup"; keep: boolean; at: number };

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
  if (v.type === "backup" && typeof v.keep === "boolean") {
    return { type: "backup", keep: v.keep, at: v.at };
  }
  if (v.type === "transcript" && typeof v.text === "string") {
    const text = v.text.trim();
    if (!text || text.length > MAX_SEGMENT_CHARS) return null;
    return { type: "transcript", text, at: v.at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 40: "Wispr Flow" notes. Besides the summary on the card, each call
// keeps its raw transcript (as the browser heard it), polished minutes
// (Claude as a dictation editor) and its recording; anyone in the call can
// ask questions about it, and each person's questions are theirs alone.
// ---------------------------------------------------------------------------

/** `PUT /calls/{callId}/audio`: the recording, once uploaded (presign + PUT, as attachments). */
export const NoteAudioSchema = z.object({
  key: z.string().min(1).max(1024),
  contentType: z
    .string()
    .regex(/^audio\/[\w.+-]+(;.*)?$/, "an audio type")
    .max(255),
  size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
  durationMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000),
});

/** The longest question about a note. */
export const MAX_NOTE_QUESTION_CHARS = 1_000;
/** How many questions one person may ask about one note (each is a model call). */
export const MAX_QUESTIONS_PER_NOTE = 30;
/** How many earlier questions (yours) the model sees, for follow-ups. */
export const NOTE_QUESTION_HISTORY = 10;

/** `POST /notes/{callId}/ask`. */
export const AskNoteSchema = z.object({
  question: z.string().trim().min(1).max(MAX_NOTE_QUESTION_CHARS),
});
export type AskNoteInput = z.infer<typeof AskNoteSchema>;

/** One question about a note and its answer (only the person who asked sees it). */
export interface NoteQuestion {
  question: string;
  answer: string;
  /** Epoch ms. */
  askedAt: number;
}

/** `GET /notes/{callId}`: the full notes of a call, for one of its participants. */
export interface NoteDetail {
  callId: string;
  /** The transcript as the browsers heard it: `[mm:ss] Name: text` lines. */
  rawTranscript: string;
  /** The polished minutes; `null` until the notes are written (or if they failed). */
  polishedText: string | null;
  /** Your questions, oldest first. */
  questions: NoteQuestion[];
}

// ---------------------------------------------------------------------------
// Phase 43: OpenAI Whisper. While notes are on, the caller's app records each
// voice (its own microphone, the other side's audio) in clips of
// `NOTES_CLIP_MS` and sends each one as it ends to `POST /calls/{callId}/clips`.
// The server hands the clip to Whisper from memory and keeps only the text
// (one `clip#…` row in `note-details`); the audio is never stored. When the
// call ends, `POST /calls/summary` with `source: "whisper"` builds the
// transcript from those rows. Clips with no speech in them aren't sent.
// The original audio is kept (as before) only if someone in the call turned
// on "Guardar audio original como respaldo".
// ---------------------------------------------------------------------------

export const WHISPER_MODEL = "whisper-1";
export const WHISPER_LANGUAGE = "es";
/** Guides Whisper through the team's Spanglish (passed as `prompt`, verbatim). */
export const WHISPER_PROMPT =
  "Reunión de desarrollo de software de MindfulTech. Hablamos en español pero usamos términos en inglés como backend, frontend, deploy, API, endpoints, dashboard, framework, AWS, features, bugs.";

/**
 * How long one clip runs: about 1 MB of Opus at 32 kbps, far under the 6 MB a
 * request may carry to a Lambda (and Whisper's 25 MB), and the most text a
 * hang-up has to wait for.
 */
export const NOTES_CLIP_MS = 4 * 60_000;
/** The largest clip accepted. */
export const MAX_NOTES_CLIP_BYTES = 4 * 1024 * 1024;
/** The longest clip accepted (a little slack over `NOTES_CLIP_MS`). */
export const MAX_NOTES_CLIP_MS = NOTES_CLIP_MS + 30_000;
/** Clips per call, both voices together: three hours of each. */
export const MAX_NOTES_CLIPS = 2 * Math.ceil((3 * 60 * 60_000) / NOTES_CLIP_MS);

/** `POST /calls/{callId}/clips?channelId=&speaker=&startedAt=&durationMs=` (the body is the audio). */
export const NotesClipQuerySchema = z.object({
  channelId: z.string().min(1).max(256),
  /** Whose voice: the caller's own, or the other side's. */
  speaker: z.string().min(1).max(128),
  /** When the clip started (epoch ms). */
  startedAt: z.coerce.number().int().positive(),
  durationMs: z.coerce.number().int().positive().max(MAX_NOTES_CLIP_MS),
});
export type NotesClipQuery = z.infer<typeof NotesClipQuerySchema>;

/** `POST /calls/{callId}/clips`: what Whisper heard, as stored. */
export interface NotesClipResult {
  /** Phrases kept (Whisper's silence and hallucinations dropped). */
  phrases: number;
}
