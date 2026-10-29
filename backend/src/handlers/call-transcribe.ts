import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  dmMembers,
  MAX_NOTES_CLIP_BYTES,
  MAX_NOTES_CLIPS,
  NotesClipQuerySchema,
  type NotesClipResult,
} from "@mindfultech/shared";
import OpenAI from "openai";
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
import {
  CLIP_TTL_SECONDS,
  CLIPS_SK,
  clipSk,
  getRawNote,
  type NoteClipRow,
} from "../lib/noteDetails";
import { openaiClient } from "../lib/openai";
import { clipLines, whisperOf, type SpeechToText, type WhisperResult } from "../lib/whisper";

let speech: SpeechToText | null = null;

/** Tests swap Whisper. */
export function useSpeechToText(next: SpeechToText | null): void {
  speech = next;
}

/** Audio formats the browsers record and Whisper reads, by the extension Whisper goes by. */
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/**
 * `POST /calls/{callId}/clips?channelId&speaker&startedAt&durationMs`
 * (Phase 43): one clip of one voice of a DM call with AI notes on, as the raw
 * request body. It goes to OpenAI Whisper straight from memory (never to S3
 * or disk) and only the text is kept, as one `clip#…` row of the call; the
 * notes are written from those rows when the call ends. Anyone in the DM may
 * send a clip of either person's voice, until the call's notes are requested.
 */
async function transcribeClip(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const callId = pathParam(event, "callId");
  if (!/^[\w-]{1,64}$/.test(callId)) throw notFound("Call not found");
  const parsed = NotesClipQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `${issue?.path.join(".") ?? "query"}: ${issue?.message ?? "invalid"}`);
  }
  const clip = parsed.data;
  const members = dmMembers(clip.channelId);
  const channel = members ? await getAccessibleChannel(clip.channelId, caller.userId) : null;
  if (!members || !channel || channel.type !== "dm") throw notFound("Conversation not found");
  if (!members.includes(clip.speaker)) {
    throw new HttpError(400, "speaker: not part of this conversation");
  }

  const contentType = (event.headers?.["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = AUDIO_TYPES[contentType];
  if (!extension) throw new HttpError(415, "The clip must be audio (webm, ogg, mp4, mp3 or wav)");
  // API Gateway hands binary bodies over in base64.
  if (!event.isBase64Encoded) throw new HttpError(400, "The clip must be sent as binary audio");
  const audio = Buffer.from(event.body ?? "", "base64");
  if (audio.length === 0) throw new HttpError(400, "The clip is empty");
  if (audio.length > MAX_NOTES_CLIP_BYTES) throw new HttpError(413, "The clip is too large");

  if (await getRawNote(callId)) {
    throw new HttpError(409, "These call notes were already requested");
  }
  if (!speech) {
    const client = await openaiClient();
    if (!client) {
      log.error("transcription isn't configured: no OpenAI API key");
      throw new HttpError(503, "Transcription isn't set up yet");
    }
    speech = whisperOf(client);
  }

  // Each clip counts (retries too), so a call can't run up the bill without
  // end; the first clip binds the call to its conversation.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.noteDetails,
        Key: { callId, sk: CLIPS_SK },
        UpdateExpression: "ADD #n :one SET channelId = :c",
        ConditionExpression:
          "(attribute_not_exists(#n) OR #n < :max) AND (attribute_not_exists(channelId) OR channelId = :c)",
        ExpressionAttributeNames: { "#n": "n" },
        ExpressionAttributeValues: { ":one": 1, ":max": MAX_NOTES_CLIPS, ":c": clip.channelId },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(429, "No more audio can be transcribed for this call");
    }
    throw err;
  }

  const started = Date.now();
  let result: WhisperResult;
  try {
    result = await speech.transcribe(audio, `clip.${extension}`, contentType);
  } catch (err) {
    log.error("clip transcription failed", {
      callId,
      bytes: audio.length,
      ms: Date.now() - started,
      ...(err instanceof OpenAI.APIError && { status: err.status }),
      ...errorFields(err),
    });
    if (err instanceof OpenAI.AuthenticationError) speech = null; // a rotated key: reload it
    if (err instanceof OpenAI.BadRequestError) {
      throw new HttpError(422, "This audio couldn't be transcribed");
    }
    throw new HttpError(
      err instanceof OpenAI.APIConnectionTimeoutError ? 504 : 503,
      "Transcription is unavailable right now. Try again.",
    );
  }

  const lines = clipLines(result, clip.startedAt);
  if (lines.length > 0) {
    const now = Date.now();
    const row: NoteClipRow = {
      callId,
      sk: clipSk(clip.startedAt, clip.speaker),
      channelId: clip.channelId,
      speaker: clip.speaker,
      startedAt: clip.startedAt,
      durationMs: clip.durationMs,
      lines,
      by: caller.userId,
      createdAt: now,
      expiresAt: Math.floor(now / 1000) + CLIP_TTL_SECONDS,
    };
    await ddb.send(new PutCommand({ TableName: tables.noteDetails, Item: row }));
  }
  // What was said is never logged; only how much.
  log.info("clip transcribed", {
    channelId: clip.channelId,
    callId,
    bytes: audio.length,
    durationMs: clip.durationMs,
    heardSeconds: result.duration,
    segments: result.segments?.length ?? 0,
    phrases: lines.length,
    ms: Date.now() - started,
  });
  const answer: NotesClipResult = { phrases: lines.length };
  return json(200, answer);
}

export const handler = httpHandler(async (event, caller) => {
  if (event.routeKey !== "POST /calls/{callId}/clips") {
    throw notFound(`No route for ${event.routeKey}`);
  }
  return transcribeClip(event, caller);
});
