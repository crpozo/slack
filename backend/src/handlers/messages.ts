import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  paginateQuery,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  canDeleteMessage,
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
import { deleteObjects } from "../lib/s3";

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
    for (const event of events) await deliver(audience, () => event);
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
              "SET deletedAt = :now, #text = :empty, attachments = :none REMOVE reactions, replyTo, isEdited, editedAt, isSecret, expiresAt, kind, meeting, aiNotes",
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
  const parentSk = reply.parentSk!;
  const key = (sk: string) => ({ channelId: reply.channelId, sk });
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.messages, Key: key(parentSk) }),
  );
  const parent = Item as Message | undefined;
  const remaining: Array<{ userId: string; createdAt: number; sk: string }> = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.messages,
      KeyConditionExpression: "channelId = :c AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":c": reply.channelId, ":prefix": threadSkPrefix(parentSk) },
      ProjectionExpression: "sk, userId, createdAt",
    },
  )) {
    for (const item of page.Items ?? []) {
      if (item.sk !== reply.sk) remaining.push(item as (typeof remaining)[number]);
    }
  }
  const replyCount = remaining.length;
  const lastReplyAt = remaining.reduce((at, r) => Math.max(at, r.createdAt), 0);
  const replyUserIds: string[] = [];
  for (const r of [...remaining].sort((a, b) => (a.sk < b.sk ? -1 : 1))) {
    const at = replyUserIds.indexOf(r.userId);
    if (at >= 0) replyUserIds.splice(at, 1);
    replyUserIds.push(r.userId);
  }
  const avatars = replyUserIds.slice(-MAX_THREAD_AVATARS);
  const was = typeof parent?.replyCount === "number" ? parent.replyCount : 0;
  const dropParent = !!parent?.deletedAt && replyCount === 0;

  const parentWrite = !parent
    ? []
    : dropParent
      ? [
          {
            Delete: {
              TableName: tables.messages,
              Key: key(parentSk),
              ConditionExpression: "attribute_exists(deletedAt) AND replyCount = :was",
              ExpressionAttributeValues: { ":was": was },
            },
          },
        ]
      : [
          {
            Update: {
              TableName: tables.messages,
              Key: key(parentSk),
              UpdateExpression:
                replyCount === 0
                  ? "SET replyCount = :count REMOVE lastReplyAt, replyUserIds"
                  : "SET replyCount = :count, lastReplyAt = :last, replyUserIds = :ids",
              ConditionExpression: "attribute_exists(sk) AND replyCount = :was",
              ExpressionAttributeValues: {
                ":count": replyCount,
                ":was": was,
                ...(replyCount > 0 && { ":last": lastReplyAt, ":ids": avatars }),
              },
            },
          },
        ];
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tables.messages,
              Key: key(reply.sk),
              ConditionExpression: "messageId = :id",
              ExpressionAttributeValues: { ":id": reply.messageId },
            },
          },
          ...parentWrite,
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

  const events: ServerEvent[] = [
    {
      type: "message.deleted",
      channelId: reply.channelId,
      sk: reply.sk,
      messageId: reply.messageId,
      parentSk,
    },
  ];
  if (parent && dropParent) {
    events.push({
      type: "message.deleted",
      channelId: reply.channelId,
      sk: parentSk,
      messageId: parent.messageId,
    });
  } else if (parent) {
    events.push({
      type: "message.thread_updated",
      channelId: reply.channelId,
      sk: parentSk,
      messageId: parent.messageId,
      replyCount,
      lastReplyAt,
      replyUserIds: replyCount > 0 ? avatars : [],
    });
  }
  return { events, parentGone: dropParent && parent ? parent : null };
}

/**
 * Quotes of the deleted message lose its copied text. A quote is always
 * newer than what it quotes, so only the conversation after it is read.
 */
async function clearQuotes(channel: Channel, deleted: Message): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
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
      const quote = item.replyTo as ReplySnapshot | undefined;
      if (quote?.sk !== deleted.sk) continue;
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
        events.push({
          type: "message.updated",
          channelId: channel.channelId,
          sk: String(item.sk),
          messageId: String(item.messageId),
          text: String(item.text ?? ""),
          replyTo,
        });
      } catch (err) {
        log.warn("quote not cleared", { channelId: channel.channelId, ...errorFields(err) });
      }
    }
  }
  return events;
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
  for (const deleted of gone) events.push(...(await clearQuotes(channel, deleted)));
  await announce(channel, events);
  return json(204);
}

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "DELETE /messages/{channelId}/{sk}": deleteMessage,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
