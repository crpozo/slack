import Anthropic from "@anthropic-ai/sdk";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  BatchGetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AskNoteSchema,
  aiNotesText,
  dmMembers,
  MAX_QUESTIONS_PER_NOTE,
  MAX_TRANSCRIPT_CHARS,
  newMessageSk,
  NoteAudioSchema,
  NOTE_QUESTION_HISTORY,
  NOTES_PAGE_SIZE,
  SummarizeCallSchema,
  type AiNotes,
  type Channel,
  type MeetingNoteIndexItem,
  type Message,
  type NoteDetail,
  type NoteQuestion,
  type NotesPage,
  type TranscriptSegment,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, listConnections } from "../lib/broadcast";
import { settleNotesCard, transcriptFor, type NotesJob } from "../lib/callNotes";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import {
  countQuestions,
  getPolished,
  listClips,
  listQuestions,
  participantNote,
  putQuestion,
  questionSk,
  RAW_SK,
  type NoteRawRow,
} from "../lib/noteDetails";
import { answerFrom, questionRequest } from "../lib/noteQuestions";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { requireEnv } from "../lib/env";
import {
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { findSentMessage, toWireMessage } from "../lib/messages";

/**
 * The transcript row stays under DynamoDB's 400 KB item limit with room to
 * spare (the transcript's own limit, in characters, keeps it there anyway).
 */
const MAX_TRANSCRIPT_BYTES = 350_000;

let lambda: LambdaClient | null = null;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

/**
 * Phase 43: the call's transcript from the clips Whisper heard (in this
 * conversation, of its people), phrase by phrase in time order. A very long
 * call keeps its first `MAX_TRANSCRIPT_CHARS`.
 */
async function whisperSegments(
  callId: string,
  channelId: string,
  participants: string[],
): Promise<TranscriptSegment[]> {
  const segments = (await listClips(callId))
    .filter((clip) => clip.channelId === channelId && participants.includes(clip.speaker))
    .flatMap((clip) => clip.lines.map(({ at, text }) => ({ userId: clip.speaker, text, at })))
    .sort((a, b) => a.at - b.at);
  let chars = 0;
  const kept = segments.filter((s) => (chars += s.text.length) <= MAX_TRANSCRIPT_CHARS);
  if (kept.length < segments.length) {
    log.warn("call transcript cut", { callId, phrases: segments.length, kept: kept.length });
  }
  return kept;
}

/**
 * `POST /calls/summary` (Phase 28): the caller's app sends the call's merged
 * transcript when a DM call with AI notes ends (from Phase 43, `source:
 * "whisper"`: the transcript is built here from the clips Whisper heard). A pending ✨ card is posted
 * in the DM at once (`message.new` to both people), the worker is started
 * asynchronously to write the notes, and the answer is 202: the summary
 * arrives as `message.updated` (generation can outlast API Gateway's 30 s).
 * A repeated request for the same call returns the card already posted.
 */
async function summarizeCall(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const input = parseBody(SummarizeCallSchema, event);
  const members = dmMembers(input.channelId);
  const channel = members ? await getAccessibleChannel(input.channelId, caller.userId) : null;
  if (!members || !channel || channel.type !== "dm") throw notFound("Conversation not found");
  const participants = [...new Set(members)].sort((a, b) => a.localeCompare(b));
  // Only the two people of the call can have spoken in it.
  if ((input.segments ?? []).some((s) => !participants.includes(s.userId))) {
    throw new HttpError(400, "segments: a speaker isn't part of this conversation");
  }

  const clientId = `ai-notes:${input.callId}`;
  const existing = await findSentMessage(input.channelId, caller.userId, clientId);
  if (existing) {
    log.info("duplicate notes request ignored", {
      channelId: input.channelId,
      callId: input.callId,
    });
    return json(202, { message: existing });
  }

  const whisper = input.source === "whisper";
  const segments = whisper
    ? await whisperSegments(input.callId, input.channelId, participants)
    : (input.segments ?? []);
  if (segments.length === 0) {
    throw new HttpError(422, "Nothing was heard in this call to take notes from");
  }
  // Phase 40: the transcript is kept (the `raw` row), as the people in it will read it.
  const transcript = await transcriptFor(segments, input.startedAt);
  if (Buffer.byteLength(transcript, "utf8") > MAX_TRANSCRIPT_BYTES) {
    throw new HttpError(413, "The transcript is too long to summarize");
  }

  const now = Date.now();
  const notes: AiNotes = {
    callId: input.callId,
    status: "pending",
    summary: "",
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    participants,
    details: true,
  };
  const message: Message = {
    messageId: ulid(now),
    channelId: input.channelId,
    sk: newMessageSk(now),
    userId: caller.userId,
    userEmail: caller.email,
    text: aiNotesText(notes),
    attachments: [],
    createdAt: now,
    reactions: {},
    kind: "ai_notes",
    aiNotes: notes,
    clientId,
  };
  const job: NotesJob = {
    card: {
      channelId: message.channelId,
      sk: message.sk,
      messageId: message.messageId,
      members: participants,
    },
    notes,
  };
  const raw: NoteRawRow = {
    callId: input.callId,
    sk: RAW_SK,
    channelId: message.channelId,
    cardSk: message.sk,
    messageId: message.messageId,
    participants,
    text: transcript,
    createdAt: now,
    ...(whisper && { source: "whisper", keepAudio: input.keepAudio === true }),
  };

  // The card, its pointers in the AI Notes hub of each person (Phase 29) and
  // its transcript (Phase 40), together: none exists without the others. A
  // call's transcript is never overwritten (by another conversation's request
  // naming the same call).
  const pointers: MeetingNoteIndexItem[] = participants.map((userId) => ({
    userId,
    sk: message.sk,
    channelId: message.channelId,
    callId: input.callId,
    endedAt: input.endedAt,
  }));
  await ddb
    .send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.messages,
              Item: message,
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          ...pointers.map((Item) => ({ Put: { TableName: tables.meetingNotes, Item } })),
          {
            Put: {
              TableName: tables.noteDetails,
              Item: raw,
              ConditionExpression: "attribute_not_exists(callId)",
            },
          },
        ],
      }),
    )
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === "TransactionCanceledException") {
        throw new HttpError(409, "These call notes were already requested");
      }
      throw err;
    });
  log.info("notes card posted", {
    channelId: message.channelId,
    callId: input.callId,
    source: whisper ? "whisper" : "browser",
    keepAudio: whisper ? input.keepAudio === true : undefined,
    segments: segments.length,
    chars: segments.reduce((n, s) => n + s.text.length, 0),
  });
  try {
    const inAudience = channelAudience(channel);
    await deliver(await listConnections(), (c) =>
      inAudience(c) ? { type: "message.new", message, clientId: "" } : null,
    );
  } catch (err) {
    log.error("notes card broadcast failed", { channelId: message.channelId, ...errorFields(err) });
  }

  try {
    await lambdaClient().send(
      new InvokeCommand({
        FunctionName: requireEnv("NOTES_WORKER_FUNCTION"),
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(job)),
      }),
    );
  } catch (err) {
    log.error("notes worker not started", { channelId: message.channelId, ...errorFields(err) });
    await settleNotesCard(job.card, {
      ...notes,
      status: "failed",
      error: "The notes couldn't be started.",
    });
    throw new HttpError(502, "The notes couldn't be started");
  }
  return json(202, { message });
}

// --- The AI Notes hub (Phase 29) -------------------------------------------------

/** The cursor is the last pointer's sort key; the user part of the key is always the caller. */
const encodeCursor = (sk: string) => Buffer.from(JSON.stringify({ sk })).toString("base64url");

function decodeCursor(cursor: string): string {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const sk = (value as { sk?: unknown } | null)?.sk;
    if (typeof sk === "string" && sk.length > 0 && sk.length <= 128) return sk;
  } catch {
    // Not ours: below.
  }
  throw new HttpError(400, "cursor: not a cursor from this endpoint");
}

/** BatchGetItem, re-asking for what DynamoDB left unprocessed (throttling) a few times. */
async function getMessages(keys: Array<{ channelId: string; sk: string }>) {
  const found: Record<string, unknown>[] = [];
  let pending: Record<string, unknown>[] = keys;
  for (let attempt = 0; pending.length > 0 && attempt < 4; attempt++) {
    const { Responses, UnprocessedKeys } = await ddb.send(
      new BatchGetCommand({ RequestItems: { [tables.messages]: { Keys: pending } } }),
    );
    found.push(...(Responses?.[tables.messages] ?? []));
    pending = (UnprocessedKeys?.[tables.messages]?.Keys ?? []) as Record<string, unknown>[];
  }
  if (pending.length > 0) throw new HttpError(503, "Couldn't load the notes, try again");
  return found;
}

/**
 * `GET /notes?cursor=` (Phase 29): your notes cards from every conversation,
 * newest first. One query on your pointers in `meeting-notes`, one batch get
 * of the cards themselves (the messages stay the single source of truth:
 * status, summary, "sent to board"). Access is checked again on read; a
 * pointer whose card or conversation is gone is skipped.
 */
async function listNotes(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const cursor = event.queryStringParameters?.cursor;
  const { Items, LastEvaluatedKey } = await ddb.send(
    new QueryCommand({
      TableName: tables.meetingNotes,
      KeyConditionExpression: "userId = :me",
      ExpressionAttributeValues: { ":me": caller.userId },
      ScanIndexForward: false,
      Limit: NOTES_PAGE_SIZE,
      ...(cursor && { ExclusiveStartKey: { userId: caller.userId, sk: decodeCursor(cursor) } }),
    }),
  );
  const pointers = (Items ?? []) as MeetingNoteIndexItem[];
  const cards =
    pointers.length === 0
      ? []
      : await getMessages(pointers.map(({ channelId, sk }) => ({ channelId, sk })));
  const byKey = new Map(cards.map((c) => [`${String(c.channelId)}|${String(c.sk)}`, c]));

  // DMs never change members; anything else is checked against the channel now.
  const channels = new Map<string, Promise<Channel | null>>();
  const mayRead = async (channelId: string) => {
    const dm = dmMembers(channelId);
    if (dm) return dm.includes(caller.userId);
    if (!channels.has(channelId)) {
      channels.set(
        channelId,
        getAccessibleChannel(channelId, caller.userId, { allowArchived: true }),
      );
    }
    return (await channels.get(channelId)!) !== null;
  };
  const notes: Message[] = [];
  for (const pointer of pointers) {
    const card = byKey.get(`${pointer.channelId}|${pointer.sk}`);
    if (card?.kind !== "ai_notes" || !(await mayRead(pointer.channelId))) continue;
    notes.push(toWireMessage(card));
  }
  const page: NotesPage = {
    notes,
    nextCursor: LastEvaluatedKey ? encodeCursor(String(LastEvaluatedKey.sk)) : null,
  };
  return json(200, page);
}

// --- Phase 40: the recording, the full notes and questions about them ---------------

/** The call in the path: `callId`s are ulids. */
function callIdOf(event: HttpEvent): string {
  const callId = pathParam(event, "callId");
  if (!/^[\w-]{1,64}$/.test(callId)) throw notFound("Notes not found");
  return callId;
}

/**
 * `PUT /calls/{callId}/audio`: the caller's app, once the recording is
 * uploaded (presign + PUT, like any attachment), attaches it to the card.
 * Anyone in the call may; the file must be in the conversation's own folder.
 * The conversation hears `message.updated`. Phase 43: for notes from Whisper,
 * only if someone in the call asked to keep the original audio.
 */
async function attachAudio(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const callId = callIdOf(event);
  const input = parseBody(NoteAudioSchema, event);
  const raw = await participantNote(callId, caller.userId);
  if (raw.source === "whisper" && raw.keepAudio !== true) {
    throw new HttpError(409, "No one in the call asked to keep its audio");
  }
  if (!input.key.startsWith(`attachments/${raw.channelId}/`) || input.key.includes("..")) {
    throw new HttpError(400, "key: not an upload of this conversation");
  }
  let card: Message;
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.messages,
        Key: { channelId: raw.channelId, sk: raw.cardSk },
        UpdateExpression: "SET aiNotes.audio = :audio",
        ConditionExpression:
          "kind = :kind AND attribute_exists(aiNotes) AND attribute_not_exists(deletedAt)",
        ExpressionAttributeValues: { ":audio": input, ":kind": "ai_notes" },
        ReturnValues: "ALL_NEW",
      }),
    );
    card = Attributes as Message;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw notFound("Notes not found");
    throw err;
  }
  log.info("call recording attached", {
    channelId: raw.channelId,
    callId,
    bytes: input.size,
    durationMs: input.durationMs,
  });
  try {
    const members = new Set(raw.participants);
    await deliver(await listConnections(), (c) =>
      members.has(c.userId)
        ? {
            type: "message.updated",
            channelId: card.channelId,
            sk: card.sk,
            messageId: card.messageId,
            text: card.text,
            aiNotes: card.aiNotes,
          }
        : null,
    );
  } catch (err) {
    log.error("recording broadcast failed", { channelId: raw.channelId, ...errorFields(err) });
  }
  return json(200, { aiNotes: card.aiNotes });
}

/**
 * `GET /notes/{callId}`: the full notes, for someone who was in the call: the
 * raw transcript, the polished minutes (once written) and only your own
 * questions about them.
 */
async function getNote(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const callId = callIdOf(event);
  const raw = await participantNote(callId, caller.userId);
  const [polishedText, questions] = await Promise.all([
    getPolished(callId),
    listQuestions(callId, caller.userId),
  ]);
  const detail: NoteDetail = { callId, rawTranscript: raw.text, polishedText, questions };
  return json(200, detail);
}

let questionModel: ClaudeModel | null = null;

/** Tests swap the model. */
export function useQuestionModel(next: ClaudeModel | null): void {
  questionModel = next;
}

/** One try, inside API Gateway's 30 seconds. */
const QUESTION_TIMEOUT_MS = 24_000;

/**
 * `POST /notes/{callId}/ask`: answers a question about the call from its
 * polished minutes (Claude Haiku 5.5, with your earlier questions for
 * follow-ups). The question and answer are kept for you alone.
 */
async function askNote(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const callId = callIdOf(event);
  const { question } = parseBody(AskNoteSchema, event);
  await participantNote(callId, caller.userId);
  const polished = await getPolished(callId);
  if (!polished) throw new HttpError(409, "These notes aren't ready for questions yet");
  if ((await countQuestions(callId, caller.userId)) >= MAX_QUESTIONS_PER_NOTE) {
    throw new HttpError(
      429,
      `You can ask up to ${MAX_QUESTIONS_PER_NOTE} questions about one call's notes`,
    );
  }
  const history = await listQuestions(callId, caller.userId, NOTE_QUESTION_HISTORY);
  const started = Date.now();
  let response: Anthropic.Message;
  try {
    response = await (questionModel ??= bedrockModel(QUESTION_TIMEOUT_MS, 0)).create(
      questionRequest(polished, history, question),
    );
  } catch (err) {
    log.error("note question failed", {
      callId,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    throw new HttpError(
      err instanceof Anthropic.RateLimitError ? 503 : 502,
      "The question couldn't be answered right now. Try again.",
    );
  }
  const answer = answerFrom(response);
  log.info("note question answered", {
    callId,
    ok: answer !== null,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
    ms: Date.now() - started,
  });
  if (!answer) throw new HttpError(502, "No answer came back. Try asking another way.");
  const askedAt = Date.now();
  const asked: NoteQuestion = { question, answer, askedAt };
  await putQuestion({
    callId,
    sk: questionSk(caller.userId, askedAt),
    userId: caller.userId,
    ...asked,
  });
  return json(200, asked);
}

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "POST /calls/summary": summarizeCall,
  "GET /notes": listNotes,
  "PUT /calls/{callId}/audio": attachAudio,
  "GET /notes/{callId}": getNote,
  "POST /notes/{callId}/ask": askNote,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
