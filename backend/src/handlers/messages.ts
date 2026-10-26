import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  GetCommand,
  paginateQuery,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  canDeleteMessage,
  type ChannelFilesPage,
  type ChannelLinksPage,
  type ChannelPins,
  MAX_THREAD_AVATARS,
  threadSkPrefix,
  type Channel,
  type Message,
  type ReplySnapshot,
  type ServerEvent,
} from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
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
  forgetMessages,
  listMedia,
  listPins,
  toChannelFile,
  toChannelLink,
  type FileRow,
  type LinkRow,
} from "../lib/media";
import { toWireMessage } from "../lib/messages";
import { deleteObjects, signAttachments, withSignedUrls } from "../lib/s3";

/**
 * `DELETE /messages/{channelId}/{sk}` (Phase 32): its author, or an admin
 * moderating, deletes a message. What happens depends on the message:
 *   - a thread reply goes, and its parent's counters follow (a parent that
 *     was itself deleted goes too once its last reply does);
 *   - a top-level message with replies becomes a tombstone ("This message
 *     was deleted": no text, files or reactions), so the thread stays;
 *   - anything else goes outright.
 * Then: its files leave S3, quotes of it elsewhere lose the copied text, and
 * everyone who can see the conversation hears `message.deleted` (or
 * `message.updated` for a tombstone) at once. Archived channels are frozen.
 */

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Malformed message key");
  }
};

/**
 * The S3 keys a message's files occupy (originals and image thumbnails):
 * only under its own conversation's folder, as `message` accepted them.
 */
const fileKeys = (message: Message) => {
  const prefix = `attachments/${message.channelId}/`;
  return (message.attachments ?? [])
    .flatMap((a) => [a.key, ...(a.thumbKey ? [a.thumbKey] : [])])
    .filter((key) => key.startsWith(prefix) && !key.includes(".."));
};

const isCancelled = (err: unknown) => err instanceof TransactionCanceledException;

/** Pushes `events` to everyone who can see `channel`; a failed push never fails the request. */
async function announce(channel: Channel, events: ServerEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const audience = (await listConnections()).filter(channelAudience(channel));
    // Each event stands on its own (a reply gone, its parent's counters), so order doesn't matter.
    await Promise.all(events.map((event) => deliver(audience, () => event)));
  } catch (err) {
    log.error("deletion broadcast failed", { channelId: channel.channelId, ...errorFields(err) });
  }
}

/** The hub pointers of an AI notes card (Phase 29), deleted with it. */
function notesPointerDeletes(message: Message) {
  if (message.kind !== "ai_notes" || !message.aiNotes) return [];
  return message.aiNotes.participants.map((userId) => ({
    Delete: { TableName: tables.meetingNotes, Key: { userId, sk: message.sk } },
  }));
}

/** Removes the message for good; `false` if a reply arrived meanwhile (it must become a tombstone). */
async function removeOutright(message: Message): Promise<boolean> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tables.messages,
              Key: { channelId: message.channelId, sk: message.sk },
              ConditionExpression:
                "messageId = :id AND (attribute_not_exists(replyCount) OR replyCount = :zero)",
              ExpressionAttributeValues: { ":id": message.messageId, ":zero": 0 },
            },
          },
          ...notesPointerDeletes(message),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isCancelled(err)) return false;
    throw err;
  }
}

/** Empties a parent with replies, keeping its row (and so its thread). */
async function tombstone(message: Message, now: number): Promise<void> {
  try {
    await writeTombstone(message, now);
  } catch (err) {
    // Gone (or already a tombstone) since it was read: someone else deleted it first.
    if (isCancelled(err)) throw notFound("Message not found");
    throw err;
  }
}

async function writeTombstone(message: Message, now: number): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.messages,
            Key: { channelId: message.channelId, sk: message.sk },
            UpdateExpression:
              "SET deletedAt = :now, #text = :empty, attachments = :none REMOVE reactions, replyTo, isEdited, editedAt, isSecret, expiresAt, kind, meeting, aiNotes, pinnedAt, pinnedBy",
            ConditionExpression: "messageId = :id AND attribute_not_exists(deletedAt)",
            ExpressionAttributeNames: { "#text": "text" },
            ExpressionAttributeValues: {
              ":now": now,
              ":empty": "",
              ":none": [],
              ":id": message.messageId,
            },
          },
        },
        ...notesPointerDeletes(message),
      ],
    }),
  );
}

interface ThreadCounters {
  replyCount: number;
  lastReplyAt: number;
  /** The newest `MAX_THREAD_AVATARS` distinct repliers, newest last. */
  replyUserIds: string[];
}

/** The thread's replies other than `reply`, as its counters need them. */
async function repliesLeft(
  reply: Message,
): Promise<Array<Pick<Message, "sk" | "userId" | "createdAt">>> {
  const left: Array<Pick<Message, "sk" | "userId" | "createdAt">> = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.messages,
      KeyConditionExpression: "channelId = :c AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":c": reply.channelId,
        ":prefix": threadSkPrefix(reply.parentSk!),
      },
      ProjectionExpression: "sk, userId, createdAt",
    },
  )) {
    for (const item of page.Items ?? []) {
      if (item.sk !== reply.sk) left.push(item as Pick<Message, "sk" | "userId" | "createdAt">);
    }
  }
  return left;
}

/** A thread's counters from its replies, as `message` keeps them when replies are written. */
function countersOf(replies: Array<Pick<Message, "sk" | "userId" | "createdAt">>): ThreadCounters {
  const ordered = [...replies].sort((a, b) => a.sk.localeCompare(b.sk));
  const repliers: string[] = [];
  for (const r of ordered) {
    const at = repliers.indexOf(r.userId);
    if (at >= 0) repliers.splice(at, 1);
    repliers.push(r.userId);
  }
  return {
    replyCount: replies.length,
    lastReplyAt: replies.reduce((at, r) => Math.max(at, r.createdAt), 0),
    replyUserIds: repliers.slice(-MAX_THREAD_AVATARS),
  };
}

/**
 * The parent's half of the transaction: recounted, or deleted when it's a
 * tombstone whose last reply goes. Either way only if no reply landed since
 * it was read (`replyCount` unchanged).
 */
function parentWrite(parent: Message, counters: ThreadCounters, dropParent: boolean) {
  const Key = { channelId: parent.channelId, sk: parent.sk };
  const was = typeof parent.replyCount === "number" ? parent.replyCount : 0;
  if (dropParent) {
    return {
      Delete: {
        TableName: tables.messages,
        Key,
        ConditionExpression: "attribute_exists(deletedAt) AND replyCount = :was",
        ExpressionAttributeValues: { ":was": was },
      },
    };
  }
  const empty = counters.replyCount === 0;
  return {
    Update: {
      TableName: tables.messages,
      Key,
      UpdateExpression: empty
        ? "SET replyCount = :count REMOVE lastReplyAt, replyUserIds"
        : "SET replyCount = :count, lastReplyAt = :last, replyUserIds = :ids",
      ConditionExpression: "attribute_exists(sk) AND replyCount = :was",
      ExpressionAttributeValues: {
        ":count": counters.replyCount,
        ":was": was,
        ...(!empty && { ":last": counters.lastReplyAt, ":ids": counters.replyUserIds }),
      },
    },
  };
}

/** What everyone hears: the reply went, and its parent went too or has new counters. */
function replyEvents(
  reply: Message,
  parent: Message | undefined,
  counters: ThreadCounters,
  dropParent: boolean,
): ServerEvent[] {
  const { channelId } = reply;
  const events: ServerEvent[] = [
    {
      type: "message.deleted",
      channelId,
      sk: reply.sk,
      messageId: reply.messageId,
      parentSk: reply.parentSk,
    },
  ];
  if (!parent) return events;
  if (dropParent) {
    events.push({ type: "message.deleted", channelId, sk: parent.sk, messageId: parent.messageId });
  } else {
    events.push({
      type: "message.thread_updated",
      channelId,
      sk: parent.sk,
      messageId: parent.messageId,
      ...counters,
    });
  }
  return events;
}

/**
 * Deletes a thread reply and recounts its parent from the replies left (the
 * avatars and "last reply" must not name the deleted one). A deleted parent
 * whose last reply goes is removed as well. One retry if another reply
 * landed between the read and the write.
 */
async function removeReply(
  reply: Message,
  attempt = 0,
): Promise<{ events: ServerEvent[]; parentGone: Message | null }> {
  const [{ Item }, left] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tables.messages,
        Key: { channelId: reply.channelId, sk: reply.parentSk! },
      }),
    ),
    repliesLeft(reply),
  ]);
  const parent = Item as Message | undefined;
  const counters = countersOf(left);
  const dropParent = !!parent?.deletedAt && counters.replyCount === 0;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tables.messages,
              Key: { channelId: reply.channelId, sk: reply.sk },
              ConditionExpression: "messageId = :id",
              ExpressionAttributeValues: { ":id": reply.messageId },
            },
          },
          ...(parent ? [parentWrite(parent, counters, dropParent)] : []),
        ],
      }),
    );
  } catch (err) {
    const reasons = isCancelled(err) ? (err.CancellationReasons ?? []) : [];
    if (reasons[0]?.Code === "ConditionalCheckFailed") throw notFound("Message not found");
    if (reasons[1]?.Code === "ConditionalCheckFailed" && attempt === 0) {
      log.info("reply deletion raced another reply; retrying", { channelId: reply.channelId });
      return removeReply(reply, 1);
    }
    throw err;
  }
  return {
    events: replyEvents(reply, parent, counters, dropParent),
    parentGone: dropParent && parent ? parent : null,
  };
}

/**
 * Quotes of the deleted message lose its copied text. A quote is always
 * newer than what it quotes, so only the conversation after it is read.
 */
async function clearQuotes(channel: Channel, deleted: Message): Promise<ServerEvent[]> {
  const quoting: Record<string, unknown>[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.messages,
      KeyConditionExpression: "channelId = :c AND sk > :sk",
      FilterExpression: "replyTo.sk = :sk",
      ExpressionAttributeValues: { ":c": channel.channelId, ":sk": deleted.sk },
      ProjectionExpression: "sk, messageId, #text, replyTo",
      ExpressionAttributeNames: { "#text": "text" },
    },
  )) {
    for (const item of page.Items ?? []) {
      if ((item.replyTo as ReplySnapshot | undefined)?.sk === deleted.sk) quoting.push(item);
    }
  }
  const events = await Promise.all(quoting.map((item) => clearQuote(channel, item)));
  return events.filter((e): e is ServerEvent => e !== null);
}

/** One quote without the deleted text; `null` if it couldn't be written (logged). */
async function clearQuote(
  channel: Channel,
  item: Record<string, unknown>,
): Promise<ServerEvent | null> {
  const quote = item.replyTo as ReplySnapshot;
  const replyTo: ReplySnapshot = {
    messageId: quote.messageId,
    sk: quote.sk,
    userId: quote.userId,
    preview: "",
    hasAttachments: false,
    deleted: true,
  };
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.messages,
        Key: { channelId: channel.channelId, sk: item.sk },
        UpdateExpression: "SET replyTo = :quote",
        ConditionExpression: "attribute_exists(sk)",
        ExpressionAttributeValues: { ":quote": replyTo },
      }),
    );
  } catch (err) {
    log.warn("quote not cleared", { channelId: channel.channelId, ...errorFields(err) });
    return null;
  }
  return {
    type: "message.updated",
    channelId: channel.channelId,
    sk: String(item.sk),
    messageId: String(item.messageId),
    text: typeof item.text === "string" ? item.text : "",
    replyTo,
  };
}

async function removeFiles(messages: Message[]): Promise<void> {
  const keys = messages.flatMap(fileKeys);
  if (keys.length === 0) return;
  try {
    await deleteObjects(keys);
  } catch (err) {
    // The message is gone either way; a leftover file is unreachable without it.
    log.error("deleted message's files not removed", { keys: keys.length, ...errorFields(err) });
  }
}

async function deleteMessage(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channelId = decode(pathParam(event, "channelId"));
  const sk = decode(pathParam(event, "sk"));
  const channel = await getAccessibleChannel(channelId, caller.userId, { allowArchived: true });
  if (!channel) throw notFound("Conversation not found");
  if (channel.archived) throw new HttpError(409, "This channel is archived");
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.messages, Key: { channelId, sk } }),
  );
  const message = Item as Message | undefined;
  if (!message || message.deletedAt) throw notFound("Message not found");
  if (!canDeleteMessage(message, caller.userId, caller.role)) {
    throw forbidden("Only its author or an admin can delete this message");
  }

  const now = Date.now();
  let events: ServerEvent[];
  const gone: Message[] = [message];
  let outcome: "reply" | "removed" | "tombstone";
  if (message.parentSk) {
    const result = await removeReply(message);
    events = result.events;
    if (result.parentGone) gone.push(result.parentGone);
    outcome = "reply";
  } else if ((message.replyCount ?? 0) === 0 && (await removeOutright(message))) {
    events = [{ type: "message.deleted", channelId, sk, messageId: message.messageId }];
    outcome = "removed";
  } else {
    await tombstone(message, now);
    events = [
      {
        type: "message.updated",
        channelId,
        sk,
        messageId: message.messageId,
        text: "",
        deletedAt: now,
      },
    ];
    outcome = "tombstone";
  }
  log.info("message deleted", {
    channelId,
    outcome,
    moderated: message.userId !== caller.userId,
    userId: caller.userId,
  });

  await removeFiles(gone);
  // Phase 38: out of the Files & Links index and the pins (a tombstone keeps neither).
  events.push(...(await forgetMessages(gone)));
  const quoteEvents = await Promise.all(gone.map((deleted) => clearQuotes(channel, deleted)));
  events.push(...quoteEvents.flat());
  await announce(channel, events);
  return json(204);
}

// --- Phase 38: a conversation's files, links and pinned messages -------------------

/** The conversation in the path, if the caller may read it (archived ones too). Never guests. */
async function readableChannel(event: HttpEvent, caller: HttpCaller): Promise<Channel> {
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  const channelId = decode(pathParam(event, "channelId"));
  const channel = await getAccessibleChannel(channelId, caller.userId, { allowArchived: true });
  if (!channel) throw notFound("Conversation not found");
  return channel;
}

const cursorOf = (event: HttpEvent) => event.queryStringParameters?.cursor || undefined;

/** `GET /channels/{channelId}/files`: its files, newest first, a page at a time. */
async function listFiles(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await readableChannel(event, caller);
  const { rows, nextCursor } = await listMedia(channel.channelId, "file", cursorOf(event));
  const now = Date.now();
  const files = await Promise.all(
    (rows as FileRow[]).map(async (row) =>
      toChannelFile(row, await withSignedUrls(row.attachment, now)),
    ),
  );
  return json(200, { files, nextCursor } satisfies ChannelFilesPage);
}

/** `GET /channels/{channelId}/links`: the links shared in it, newest first. */
async function listLinks(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await readableChannel(event, caller);
  const { rows, nextCursor } = await listMedia(channel.channelId, "link", cursorOf(event));
  const links = (rows as LinkRow[]).map(toChannelLink);
  return json(200, { links, nextCursor } satisfies ChannelLinksPage);
}

/** DynamoDB caps BatchGetItem at 100 keys. */
const BATCH_GET = 100;

/**
 * `GET /channels/{channelId}/pins`: its pinned messages as they are now (the
 * index only points at them), most recently pinned first.
 */
async function listPinned(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await readableChannel(event, caller);
  const pins = await listPins(channel.channelId);
  const found = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < pins.length; i += BATCH_GET) {
    let keys = pins
      .slice(i, i + BATCH_GET)
      .map((p) => ({ channelId: p.channelId, sk: p.messageSk }));
    // Unprocessed keys (throttling) are asked again, a few times.
    for (let attempt = 0; keys.length > 0 && attempt < 3; attempt++) {
      const { Responses, UnprocessedKeys } = await ddb.send(
        new BatchGetCommand({ RequestItems: { [tables.messages]: { Keys: keys } } }),
      );
      for (const item of Responses?.[tables.messages] ?? []) found.set(String(item.sk), item);
      keys = (UnprocessedKeys?.[tables.messages]?.Keys ?? []) as typeof keys;
    }
  }
  const now = Date.now();
  const messages = await Promise.all(
    pins
      .map((p) => found.get(p.messageSk))
      // Deleted (or emptied) since: the deletion cleans its row up.
      .filter(
        (item): item is Record<string, unknown> => !!item && !item.deletedAt && !!item.pinnedAt,
      )
      .map((item) => signAttachments(toWireMessage(item), now)),
  );
  return json(200, { messages } satisfies ChannelPins);
}

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "DELETE /messages/{channelId}/{sk}": deleteMessage,
  "GET /channels/{channelId}/files": listFiles,
  "GET /channels/{channelId}/links": listLinks,
  "GET /channels/{channelId}/pins": listPinned,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
