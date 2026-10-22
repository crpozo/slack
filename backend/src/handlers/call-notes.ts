import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { BatchGetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  aiNotesText,
  dmMembers,
  newMessageSk,
  NOTES_PAGE_SIZE,
  SummarizeCallSchema,
  type AiNotes,
  type Channel,
  type MeetingNoteIndexItem,
  type Message,
  type NotesPage,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, listConnections } from "../lib/broadcast";
import { settleNotesCard, type NotesJob } from "../lib/callNotes";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { requireEnv } from "../lib/env";
import {
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { findSentMessage, toWireMessage } from "../lib/messages";

/** Async invocations carry at most 256 KB; the job stays well under it. */
const MAX_JOB_BYTES = 240_000;

let lambda: LambdaClient | null = null;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

/**
 * `POST /calls/summary` (Phase 28): the caller's app sends the call's merged
 * transcript when a DM call with AI notes ends. A pending ✨ card is posted
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
  if (input.segments.some((s) => !participants.includes(s.userId))) {
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

  const now = Date.now();
  const notes: AiNotes = {
    callId: input.callId,
    status: "pending",
    summary: "",
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    participants,
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
    segments: input.segments,
  };
  const payload = JSON.stringify(job);
  if (Buffer.byteLength(payload, "utf8") > MAX_JOB_BYTES) {
    throw new HttpError(413, "The transcript is too long to summarize");
  }

  // The card and its pointers in the AI Notes hub of each person (Phase 29),
  // together: neither exists without the other.
  const pointers: MeetingNoteIndexItem[] = participants.map((userId) => ({
    userId,
    sk: message.sk,
    channelId: message.channelId,
    callId: input.callId,
    endedAt: input.endedAt,
  }));
  await ddb.send(
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
      ],
    }),
  );
  log.info("notes card posted", {
    channelId: message.channelId,
    callId: input.callId,
    segments: input.segments.length,
    chars: input.segments.reduce((n, s) => n + s.text.length, 0),
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
        Payload: new TextEncoder().encode(payload),
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

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "POST /calls/summary": summarizeCall,
  "GET /notes": listNotes,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
