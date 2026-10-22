import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  aiNotesText,
  dmMembers,
  newMessageSk,
  SummarizeCallSchema,
  type AiNotes,
  type Message,
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
import { findSentMessage } from "../lib/messages";

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

  await ddb.send(
    new PutCommand({
      TableName: tables.messages,
      Item: message,
      ConditionExpression: "attribute_not_exists(sk)",
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

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "POST /calls/summary": summarizeCall,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
