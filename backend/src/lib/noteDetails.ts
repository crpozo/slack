import { GetCommand, paginateQuery, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { NoteQuestion } from "@mindfultech/shared";
import type { ClipLine } from "./whisper";
import { batchDelete, ddb, tables } from "./ddb";
import { notFound } from "./http";

// ---------------------------------------------------------------------------
// Phase 40: a call's full notes, kept apart from its ✨ card (a card travels
// in history pages over the WebSocket, whose frames can't carry a two-hour
// transcript). One partition per call:
//
//   raw                        the transcript as the browsers heard it, and
//                              who may read any of this (the participants)
//   polished                   the minutes Claude wrote from it
//   qa#<userId>#<askedAt>      one question of one person, and its answer:
//                              only ever read back for that person
//   clips                      Phase 43: how many clips Whisper heard, and
//                              the conversation the call belongs to
//   clip#<startedAt>#<userId>  what Whisper heard in one clip of one voice
//                              (text only: the audio is never stored); kept
//                              a week, as the transcript moves into `raw`
// ---------------------------------------------------------------------------

export const RAW_SK = "raw";
export const POLISHED_SK = "polished";

export interface NoteRawRow {
  callId: string;
  sk: typeof RAW_SK;
  /** Where the card is (`channelId` + `cardSk`), for attaching the recording. */
  channelId: string;
  cardSk: string;
  messageId: string;
  /** Who was in the call: the only people who may read the notes. */
  participants: string[];
  /** `[mm:ss] Name: text` lines. */
  text: string;
  createdAt: number;
  /** Phase 43: transcribed by Whisper from the call's clips (else by the browsers). */
  source?: "whisper";
  /** Phase 43: someone asked to keep the original audio; without it none is attached. */
  keepAudio?: boolean;
}

export interface NotePolishedRow {
  callId: string;
  sk: typeof POLISHED_SK;
  text: string;
  createdAt: number;
}

export interface NoteQuestionRow extends NoteQuestion {
  callId: string;
  sk: string;
  userId: string;
}

/** A person's questions sort by time under their own prefix. */
export const questionPrefix = (userId: string) => `qa#${userId}#`;
export const questionSk = (userId: string, askedAt: number) =>
  `${questionPrefix(userId)}${String(askedAt).padStart(13, "0")}`;

export const CLIPS_SK = "clips";
export const CLIP_PREFIX = "clip#";
export const clipSk = (startedAt: number, speaker: string) =>
  `${CLIP_PREFIX}${String(startedAt).padStart(13, "0")}#${speaker}`;
/** Clip rows outlive the call long enough for its notes to be requested. */
export const CLIP_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface NoteClipRow {
  callId: string;
  sk: string;
  channelId: string;
  /** Whose voice. */
  speaker: string;
  startedAt: number;
  durationMs: number;
  lines: ClipLine[];
  /** Who sent the clip. */
  by: string;
  createdAt: number;
  /** DynamoDB TTL (epoch seconds). */
  expiresAt: number;
}

export async function getRawNote(callId: string): Promise<NoteRawRow | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.noteDetails, Key: { callId, sk: RAW_SK } }),
  );
  return Item as NoteRawRow | undefined;
}

/** The call's notes, if `userId` was in the call (404 otherwise, as for a call that isn't there). */
export async function participantNote(callId: string, userId: string): Promise<NoteRawRow> {
  const raw = await getRawNote(callId);
  if (!raw || !raw.participants.includes(userId)) throw notFound("Notes not found");
  return raw;
}

export async function getPolished(callId: string): Promise<string | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.noteDetails, Key: { callId, sk: POLISHED_SK } }),
  );
  return typeof Item?.text === "string" ? Item.text : null;
}

export async function putPolished(callId: string, text: string, now = Date.now()): Promise<void> {
  const row: NotePolishedRow = { callId, sk: POLISHED_SK, text, createdAt: now };
  await ddb.send(new PutCommand({ TableName: tables.noteDetails, Item: row }));
}

/** `userId`'s questions about the call: oldest first, or the newest `limit` (still oldest first). */
export async function listQuestions(
  callId: string,
  userId: string,
  limit?: number,
): Promise<NoteQuestion[]> {
  const rows: NoteQuestionRow[] = [];
  const query = {
    TableName: tables.noteDetails,
    KeyConditionExpression: "callId = :c AND begins_with(sk, :p)",
    ExpressionAttributeValues: { ":c": callId, ":p": questionPrefix(userId) },
  };
  if (limit !== undefined) {
    const { Items } = await ddb.send(
      new QueryCommand({ ...query, ScanIndexForward: false, Limit: limit }),
    );
    rows.push(...((Items ?? []) as NoteQuestionRow[]).reverse());
  } else {
    for await (const page of paginateQuery({ client: ddb }, query)) {
      rows.push(...((page.Items ?? []) as NoteQuestionRow[]));
    }
  }
  return rows.map(({ question, answer, askedAt }) => ({ question, answer, askedAt }));
}

export async function countQuestions(callId: string, userId: string): Promise<number> {
  const { Count } = await ddb.send(
    new QueryCommand({
      TableName: tables.noteDetails,
      KeyConditionExpression: "callId = :c AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":c": callId, ":p": questionPrefix(userId) },
      Select: "COUNT",
    }),
  );
  return Count ?? 0;
}

export async function putQuestion(row: NoteQuestionRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: tables.noteDetails, Item: row }));
}

/** Everything kept about a call (its card was deleted): transcript, minutes, questions. */
export async function forgetNote(callId: string): Promise<number> {
  const keys: Array<{ callId: string; sk: string }> = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.noteDetails,
      KeyConditionExpression: "callId = :c",
      ExpressionAttributeValues: { ":c": callId },
      ProjectionExpression: "callId, sk",
    },
  )) {
    keys.push(...((page.Items ?? []) as typeof keys));
  }
  await batchDelete(tables.noteDetails, keys);
  return keys.length;
}

/** The call's clips, oldest first. */
export async function listClips(callId: string): Promise<NoteClipRow[]> {
  const rows: NoteClipRow[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.noteDetails,
      KeyConditionExpression: "callId = :c AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":c": callId, ":p": CLIP_PREFIX },
    },
  )) {
    rows.push(...((page.Items ?? []) as NoteClipRow[]));
  }
  return rows;
}
