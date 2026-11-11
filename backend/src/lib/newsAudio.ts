import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { NewsInsights } from "@mindfultech/shared";
import { requireEnv } from "./env";

// ---------------------------------------------------------------------------
// AI News in audio (Phase 54): the morning's analysis read aloud in Spanish,
// about a minute (Phase 60: it was four). The script is built from the
// analysis itself (no second model call): the top stories, each as its
// headline and the one sentence of what happened. Amazon Polly reads
// it with a neural Spanish voice; the MP3 is kept in the attachments bucket
// under `news-audio/` and the page plays it through a presigned URL.
// ---------------------------------------------------------------------------

/** Where the day's audio lives in the attachments bucket (the endpoint may sign only these). */
export const NEWS_AUDIO_PREFIX = "news-audio/";

/** A neural voice in Latin American Spanish (es-US), as the team speaks. */
export const NEWS_AUDIO_VOICE = "Lupe";

/** Polly takes at most 3,000 billed characters a request: the script is read in pieces. */
const MAX_CHARS_PER_REQUEST = 2_800;

/** At most this many stories are read (as many as fit the minute). */
const STORIES_READ = 4;
/** About a minute of speech (Polly's neural voices read some 15 characters a second). */
export const AUDIO_BUDGET_CHARS = 900;

const ORDINALS = ["Primero", "Segundo", "Tercero", "Cuarto"];

/** Text as it should be read: no markdown marks, no links, tidy spaces and endings. */
function spoken(text: string): string {
  const clean = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean && !/[.!?…:]$/.test(clean) ? `${clean}.` : clean;
}

/** "lunes 9 de noviembre", from the analysis's `YYYY-MM-DD`. */
export function spokenDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(Date.UTC(y, m - 1, d));
}

/** Up to the first full stop: one sentence, the fact. */
function firstSentence(text: string): string {
  const clean = spoken(text);
  const end = clean.search(/[.!?…](\s|$)/);
  return end === -1 ? clean : clean.slice(0, end + 1);
}

/**
 * The script read aloud, in about a minute (`AUDIO_BUDGET_CHARS`): the day,
 * a new Claude model if there is one, then the top stories, most important
 * first, each as its headline and the one sentence of what happened. As many
 * stories as fit (always the first, at most `STORIES_READ`); trends, actions
 * and sources stay on the page.
 */
export function audioScript(
  insights: Pick<NewsInsights, "day" | "stories" | "claudeAlert">,
): string {
  const SIGN_OFF = "Los detalles, en AI News.";
  const parts: string[] = [];
  const day = spokenDay(insights.day);
  parts.push(`AI News${day ? `, ${day}` : ""}. Lo más importante en un minuto.`);
  // Phase 56: a new Claude model goes first.
  const alert = insights.claudeAlert;
  if (alert) {
    const name = alert.model ? `: ${spoken(alert.model).replace(/\.$/, "")}` : "";
    const lead =
      alert.status === "launched"
        ? `Atención: Anthropic lanzó un nuevo modelo de Claude${name}.`
        : `Atención: Anthropic prepara un nuevo modelo de Claude${name}.`;
    parts.push(`${lead}${alert.summary ? ` ${firstSentence(alert.summary)}` : ""}`);
  }
  let used = parts.join("\n\n").length + SIGN_OFF.length;
  insights.stories.slice(0, STORIES_READ).forEach((story, i) => {
    const fact = story.summary ? ` ${firstSentence(story.summary)}` : "";
    const line = `${ORDINALS[i] ?? "Además"}: ${spoken(story.headline)}${fact}`;
    if (i > 0 && used + line.length > AUDIO_BUDGET_CHARS) return;
    parts.push(line);
    used += line.length + 2;
  });
  parts.push(SIGN_OFF);
  return parts.join("\n\n");
}

/** The script in pieces Polly accepts, cut between paragraphs, then sentences. */
export function scriptChunks(script: string, max = MAX_CHARS_PER_REQUEST): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current += `\n${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  };
  for (const paragraph of script.split(/\n{2,}/)) {
    if (paragraph.length <= max) {
      push(paragraph);
      continue;
    }
    // A very long paragraph: by sentences (and a sentence longer than `max`, cut hard).
    for (const sentence of paragraph.match(/[^.!?…]+[.!?…]*\s*/g) ?? [paragraph]) {
      for (let at = 0; at < sentence.length; at += max) push(sentence.slice(at, at + max).trim());
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

let polly: PollyClient | null = null;
let s3: S3Client | null = null;

/** Tests swap the clients. */
export function useNewsAudioClients(next: { polly?: PollyClient; s3?: S3Client } | null): void {
  polly = next?.polly ?? null;
  s3 = next?.s3 ?? null;
}

/** Reads `text` aloud: one MP3 (the pieces' frames, back to back, play as one file). */
export async function synthesize(text: string): Promise<Uint8Array> {
  const client = (polly ??= new PollyClient({}));
  const parts: Uint8Array[] = [];
  for (const chunk of scriptChunks(text)) {
    const { AudioStream } = await client.send(
      new SynthesizeSpeechCommand({
        Engine: "neural",
        VoiceId: NEWS_AUDIO_VOICE,
        LanguageCode: "es-US",
        OutputFormat: "mp3",
        SampleRate: "24000",
        TextType: "text",
        Text: chunk,
      }),
    );
    if (!AudioStream) throw new Error("Polly returned no audio");
    parts.push(await AudioStream.transformToByteArray());
  }
  const audio = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    audio.set(part, at);
    at += part.length;
  }
  return audio;
}

/** The day's summary as an MP3 in the bucket; returns its key. */
export async function writeNewsAudio(
  insights: Pick<NewsInsights, "day" | "generatedAt" | "stories" | "claudeAlert">,
): Promise<{ key: string; chars: number }> {
  const script = audioScript(insights);
  const audio = await synthesize(script);
  const key = `${NEWS_AUDIO_PREFIX}${insights.day}-${insights.generatedAt}.mp3`;
  await (s3 ??= new S3Client({})).send(
    new PutObjectCommand({
      Bucket: requireEnv("ATTACHMENTS_BUCKET"),
      Key: key,
      Body: audio,
      ContentType: "audio/mpeg",
      CacheControl: "private, max-age=86400, immutable",
    }),
  );
  return { key, chars: script.length };
}

/** About how long a script takes to read (Polly's neural voices: ~15 characters a second). */
export function spokenSeconds(chars: number): number {
  return Math.round(chars / 15);
}
