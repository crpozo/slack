import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_TRANSCRIBE_BYTES,
  transcribableAudio,
  type Message,
  type MessageTranscriptResult,
} from "@mindfultech/shared";
import { getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import {
  HttpError,
  httpHandler,
  json,
  notFound,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { openaiClient } from "../lib/openai";
import { readObject } from "../lib/s3";
import { audioExtension, clipLines, whisperOf, type SpeechToText } from "../lib/whisper";

// ---------------------------------------------------------------------------
// Phase 58: a voice message's transcript, on demand. The first person to ask
// pays for one Whisper request (the same key, model, language and Spanglish
// prompt as the AI notes of calls); the text is kept on the message and
// everyone after reads it from there. The audio goes from S3 to OpenAI in
// this Lambda's memory, never to `/tmp`.
// ---------------------------------------------------------------------------

let speech: SpeechToText | null = null;

/** Tests swap Whisper. */
export function useSpeechToText(next: SpeechToText | null): void {
  speech = next;
}

/**
 * While one request transcribes a message, it holds `transcribingAt`: a second
 * request (someone else clicking at the same time) waits instead of paying for
 * the same audio. A hold older than this was a Lambda that died (they run 30 s).
 */
export const TRANSCRIBE_HOLD_MS = 60_000;
/** The longest transcript kept (DynamoDB items are 400 KB; this is about an hour of speech). */
export const MAX_TRANSCRIPT_CHARS = 40_000;

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Malformed message key");
  }
};

async function getMessage(channelId: string, sk: string): Promise<Message | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.messages, Key: { channelId, sk } }),
  );
  const message = Item as (Message & { deletedAt?: number }) | undefined;
  return message && !message.deletedAt ? message : null;
}

const cached = (transcript: string): HttpResult =>
  json(200, { transcript, cached: true } satisfies MessageTranscriptResult);

/** Takes the hold, or says why not: transcribed already, gone, or someone else is at it. */
async function claim(channelId: string, sk: string, now: number): Promise<HttpResult | null> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.messages,
        Key: { channelId, sk },
        UpdateExpression: "SET transcribingAt = :now",
        ConditionExpression:
          "attribute_exists(sk) AND attribute_not_exists(deletedAt) AND " +
          "attribute_not_exists(transcript) AND " +
          "(attribute_not_exists(transcribingAt) OR transcribingAt < :stale)",
        ExpressionAttributeValues: { ":now": now, ":stale": now - TRANSCRIBE_HOLD_MS },
      }),
    );
    return null;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  const latest = await getMessage(channelId, sk);
  if (!latest) throw notFound("Message not found");
  if (typeof latest.transcript === "string") return cached(latest.transcript);
  throw new HttpError(409, "It's being transcribed right now; try again in a few seconds");
}

/** Gives the hold back after a failure, so the next click can try again at once. */
async function release(channelId: string, sk: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.messages,
        Key: { channelId, sk },
        UpdateExpression: "REMOVE transcribingAt",
        ConditionExpression: "attribute_exists(sk)",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      log.warn("couldn't release a transcription hold", { channelId, sk, ...errorFields(err) });
    }
  }
}

/**
 * `POST /messages/{channelId}/{sk}/transcribe` (Phase 58): the transcript of
 * a voice message in a conversation the caller can read. Kept on the message
 * (`transcript`), so a second request answers from DynamoDB without calling
 * OpenAI; `cached` says which it was. `""` means no speech was heard.
 */
async function transcribe(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channelId = decode(pathParam(event, "channelId"));
  const sk = decode(pathParam(event, "sk"));
  const channel = await getAccessibleChannel(channelId, caller, { allowArchived: true });
  if (!channel) throw notFound("Conversation not found");
  const message = await getMessage(channelId, sk);
  if (!message) throw notFound("Message not found");
  // a. Already transcribed: answered from the row, OpenAI isn't called.
  if (typeof message.transcript === "string") return cached(message.transcript);

  const audio = transcribableAudio(message);
  if (!audio) throw new HttpError(400, "This message has no audio");
  const extension = audioExtension(audio.contentType);
  if (!extension) throw new HttpError(415, "This audio format can't be transcribed");
  if (audio.size > MAX_TRANSCRIBE_BYTES) {
    throw new HttpError(413, "This audio is too long to transcribe");
  }
  if (!speech) {
    const client = await openaiClient();
    if (!client) {
      log.error("transcription isn't configured: no OpenAI API key");
      throw new HttpError(503, "Transcription isn't set up yet");
    }
    speech = whisperOf(client);
  }

  const held = await claim(channelId, sk, Date.now());
  if (held) return held;
  const started = Date.now();
  let transcript: string;
  try {
    // b. The voice message from S3, straight into memory.
    const bytes = await readObject(audio.key, MAX_TRANSCRIBE_BYTES);
    // c. Whisper, with the AI notes' key, model, language and prompt.
    const result = await speech.transcribe(bytes, `voice.${extension}`, audio.contentType);
    transcript = clipLines(result, 0)
      .map((line) => line.text)
      .join(" ")
      .slice(0, MAX_TRANSCRIPT_CHARS);
  } catch (err) {
    await release(channelId, sk);
    log.error("voice message transcription failed", {
      channelId,
      sk,
      key: audio.key,
      ...errorFields(err),
    });
    throw new HttpError(502, "Couldn't transcribe it just now. Try again.");
  }

  // d. Kept on the message, and the hold given back, in one write.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.messages,
        Key: { channelId, sk },
        UpdateExpression: "SET transcript = :t REMOVE transcribingAt",
        ConditionExpression: "attribute_exists(sk) AND attribute_not_exists(deletedAt)",
        ExpressionAttributeValues: { ":t": transcript },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw notFound("Message not found");
    throw err;
  }
  log.info("voice message transcribed", {
    channelId,
    sk,
    userId: caller.userId,
    bytes: audio.size,
    durationMs: audio.durationMs,
    chars: transcript.length,
    tookMs: Date.now() - started,
  });
  // e. Back to the client.
  return json(200, { transcript, cached: false } satisfies MessageTranscriptResult);
}

export const handler = httpHandler(async (event, caller) => {
  if (event.routeKey === "POST /messages/{channelId}/{sk}/transcribe") {
    return transcribe(event, caller);
  }
  throw notFound(`No route for ${event.routeKey}`);
});
