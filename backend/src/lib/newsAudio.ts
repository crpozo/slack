import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { NewsInsights } from "@mindfultech/shared";
import { requireEnv } from "./env";
import { errorFields, log } from "./logger";
import { optionalSecret } from "./secret";

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

/** About a minute and a half, read briskly (some 16 characters a second). */
export const AUDIO_BUDGET_CHARS = 1_450;
/** How the update opens: straight to the news. */
const AUDIO_OPENING = "Update de noticias.";

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
 * The script read aloud, in about a minute and a half (`AUDIO_BUDGET_CHARS`),
 * straight to the point: "Update de noticias.", a new Claude model if there
 * is one, then every story, most important first, as its headline and the
 * one sentence of what happened — no numbering, no sign-off. When the time
 * runs short a story is read as its headline alone, and then left out
 * (the first is always read); trends, actions and sources stay on the page.
 */
export function audioScript(insights: Pick<NewsInsights, "stories" | "claudeAlert">): string {
  const parts: string[] = [AUDIO_OPENING];
  // Phase 56: a new Claude model goes first.
  const alert = insights.claudeAlert;
  if (alert) {
    const name = alert.model ? `: ${spoken(alert.model).replace(/\.$/, "")}` : "";
    const lead =
      alert.status === "launched"
        ? `Anthropic lanzó un nuevo modelo de Claude${name}.`
        : `Anthropic prepara un nuevo modelo de Claude${name}.`;
    parts.push(`${lead}${alert.summary ? ` ${firstSentence(alert.summary)}` : ""}`);
  }
  let used = parts.join("\n\n").length;
  insights.stories.forEach((story, i) => {
    const headline = spoken(story.headline);
    const full = story.summary ? `${headline} ${firstSentence(story.summary)}` : headline;
    const line = [full, headline].find((l) => used + l.length + 2 <= AUDIO_BUDGET_CHARS);
    if (!line && i > 0) return;
    parts.push(line ?? full);
    used += (line ?? full).length + 2;
  });
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

// --- ElevenLabs (Phase 61): a more natural voice, when its key is set -----------------

export const elevenLabsKey = optionalSecret("ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY_PARAMETER");
/** Optional: another voice from the account's library (its id). */
export const elevenLabsVoice = optionalSecret(
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_VOICE_ID_PARAMETER",
);
/** "George", one of ElevenLabs' stock voices: used until a voice id is configured. */
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
/** The multilingual model: it reads Spanish as Spanish. */
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const ELEVENLABS_TIMEOUT_MS = 60_000;
/**
 * A newsreader's delivery rather than a flat read: less stability lets the
 * voice move, some style adds emphasis, and the speaker boost makes it fuller.
 */
export const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.8,
  style: 0.35,
  use_speaker_boost: true,
  // Brisk, as a news update is read (1 is the voice's own pace; 1.2 the most).
  speed: 1.12,
} as const;

let fetchImpl: typeof fetch = (...args) => fetch(...args);
/** Tests swap the network. */
export function useNewsAudioFetch(next: typeof fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

/** Reads `text` aloud with ElevenLabs: one MP3. Throws when the service refuses or fails. */
export async function synthesizeWithElevenLabs(text: string, apiKey: string): Promise<Uint8Array> {
  const voice = (await elevenLabsVoice.get()) ?? ELEVENLABS_DEFAULT_VOICE;
  // No `language_code`: the multilingual model rejects it (it reads the
  // language off the text), which is what kept sending the read to Polly.
  const ask = (body: Record<string, unknown>) =>
    fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      },
    );
  let response = await ask({
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: ELEVENLABS_VOICE_SETTINGS,
  });
  // A setting this voice or plan doesn't take: read it plainly rather than not at all.
  if (response.status === 400 || response.status === 422) {
    response = await ask({ text, model_id: ELEVENLABS_MODEL });
  }
  if (!response.ok) {
    // The body says why (a bad key, no credits, an unknown voice): never the key itself.
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`ElevenLabs answered ${response.status}: ${detail}`);
  }
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length === 0) throw new Error("ElevenLabs returned no audio");
  return audio;
}

/** Which service read the summary. */
export type NewsAudioVoice = "elevenlabs" | "polly";

/**
 * Reads `text` aloud: with ElevenLabs when its key is configured, else (or if
 * ElevenLabs fails: no credits, an outage) with Amazon Polly, so there is
 * always an audio.
 */
export async function speak(text: string): Promise<{ audio: Uint8Array; voice: NewsAudioVoice }> {
  const key = await elevenLabsKey.get();
  if (key) {
    try {
      return { audio: await synthesizeWithElevenLabs(text, key), voice: "elevenlabs" };
    } catch (err) {
      log.warn("elevenlabs failed, reading with polly", errorFields(err));
    }
  }
  return { audio: await synthesize(text), voice: "polly" };
}

/** Reads `text` aloud with Amazon Polly: one MP3 (the pieces' frames, back to back, play as one file). */
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
): Promise<{ key: string; chars: number; voice: NewsAudioVoice }> {
  const script = audioScript(insights);
  const { audio, voice } = await speak(script);
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
  return { key, chars: script.length, voice };
}

/** About how long a script takes to read (Polly's neural voices: ~15 characters a second). */
export function spokenSeconds(chars: number): number {
  return Math.round(chars / 15);
}
