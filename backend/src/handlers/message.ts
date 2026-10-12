import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  MessageActionSchema,
  newMessageSk,
  parseAction,
  type Message,
  type MessageNewEvent,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { broadcast } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, replyError } from "../lib/response";

/** `message`: persists a message and fans it out as `message.new` to the channel's audience. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(MessageActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, text, attachments = [], clientId } = parsed.data;

  if (!text.trim() && attachments.length === 0) {
    return badRequest(caller.connectionId, "Message is empty");
  }
  if (attachments.some((a) => !a.key.startsWith(`attachments/${channelId}/`))) {
    return badRequest(caller.connectionId, "Attachment does not belong to this channel");
  }

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");

  const now = Date.now();
  const message: Message = {
    messageId: ulid(now),
    channelId,
    sk: newMessageSk(now),
    userId: caller.userId,
    userEmail: caller.userEmail,
    text,
    attachments,
    createdAt: now,
    // An empty map up front lets `react` ADD to `reactions.<emoji>` directly.
    reactions: {},
  };
  await ddb.send(new PutCommand({ TableName: tables.messages, Item: message }));
  log.info("message stored", { channelId, messageId: message.messageId, userId: caller.userId });

  const newMessage: MessageNewEvent = { type: "message.new", message, clientId };
  const inAudience = channelAudience(channel);
  await broadcast((connection) => (inAudience(connection) ? newMessage : null));
  return ok();
});
