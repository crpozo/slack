import { WHISPER_LANGUAGE, WHISPER_MODEL, WHISPER_PROMPT } from "@mindfultech/shared";
import { toFile } from "openai";
import type OpenAI from "openai";
import type { TranscriptionVerbose } from "openai/resources/audio/transcriptions";

// ---------------------------------------------------------------------------
// Phase 43: one clip of a call through OpenAI Whisper, and what of its answer
// is kept. The audio only ever exists in this Lambda's memory.
// ---------------------------------------------------------------------------

/** What Whisper heard in a clip: its text, in timed segments. */
export type WhisperResult = Pick<TranscriptionVerbose, "text" | "segments" | "duration">;

/** The part of the OpenAI client the endpoint uses (a fake in tests). */
export interface SpeechToText {
  transcribe(audio: Buffer, fileName: string, contentType: string): Promise<WhisperResult>;
}

/**
 * `POST /v1/audio/transcriptions`: `whisper-1`, Spanish, with the prompt that
 * tells it the team's English technical terms, and `verbose_json` for the
 * segments' times and confidence.
 */
export function whisperOf(client: Pick<OpenAI, "audio">): SpeechToText {
  return {
    async transcribe(audio, fileName, contentType) {
      return client.audio.transcriptions.create({
        file: await toFile(audio, fileName, { type: contentType }),
        model: WHISPER_MODEL,
        language: WHISPER_LANGUAGE,
        prompt: WHISPER_PROMPT,
        response_format: "verbose_json",
        temperature: 0,
      });
    },
  };
}

/** One phrase of a clip: when it was said (epoch ms) and what. */
export interface ClipLine {
  at: number;
  text: string;
}

/** Above this, and with a low confidence, a segment is silence Whisper filled in. */
const NO_SPEECH_PROB = 0.6;
const LOW_LOGPROB = -1;
/** Above this a segment is Whisper repeating itself. */
const MAX_COMPRESSION_RATIO = 2.4;

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * What Whisper writes over silence and noise in Spanish (it learned them from
 * subtitled videos): never what someone in a work call said.
 */
const HALLUCINATIONS = [
  "subtitulos realizados por la comunidad de amara org",
  "subtitulos por la comunidad de amara org",
  "amara org",
  "gracias por ver el video",
  "gracias por ver",
  "suscribete al canal",
  "suscribete",
  "no olvides suscribirte",
  "subtitulado por",
].map(normalize);

const PROMPT = normalize(WHISPER_PROMPT);

function isHallucination(text: string): boolean {
  const n = normalize(text);
  if (!n) return true;
  if (n.includes("amara org")) return true;
  if (HALLUCINATIONS.some((h) => n === h || n === `${h} gracias`)) return true;
  // The prompt read back (Whisper does this over a silent clip).
  return n.length >= 20 && PROMPT.includes(n);
}

/**
 * The phrases worth keeping from a clip that started at `startedAt`: silence,
 * repetition loops, subtitle credits and the prompt read back are dropped.
 */
export function clipLines(result: WhisperResult, startedAt: number): ClipLine[] {
  const segments = result.segments ?? [
    { start: 0, text: result.text, no_speech_prob: 0, avg_logprob: 0, compression_ratio: 1 },
  ];
  const lines: ClipLine[] = [];
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, " ").trim();
    if (s.no_speech_prob > NO_SPEECH_PROB && s.avg_logprob < LOW_LOGPROB) continue;
    if (s.compression_ratio > MAX_COMPRESSION_RATIO) continue;
    if (isHallucination(text)) continue;
    const at = startedAt + Math.max(0, Math.round(s.start * 1000));
    // The same phrase twice in a row is Whisper stuttering, not the speaker.
    if (lines.at(-1)?.text === text) continue;
    lines.push({ at, text });
  }
  return lines;
}
