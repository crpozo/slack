import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  canAccessChannel,
  dmMembers,
  MessageActionSchema,
  newMessageSk,
  parseAction,
  type Channel,
  type Message,
  type MessageNewEvent,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { broadcast } from "../lib/broadcast";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, replyError } from "../lib/response";

/** `message`: persists a message and fans it out as `message.new`. */
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
  if (!canAccessChannel(channelId, caller.userId)) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }

  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.channels,
      Key: { channelId },
      ProjectionExpression: "channelId, archived",
    }),
  );
  const channel = Item as Pick<Channel, "channelId" | "archived"> | undefined;
  if (!channel || channel.archived) {
    return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  }

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
  };
  await ddb.send(new PutCommand({ TableName: tables.messages, Item: message }));
  log.info("message stored", { channelId, messageId: message.messageId, userId: caller.userId });

  const newMessage: MessageNewEvent = { type: "message.new", message, clientId };
  const members = dmMembers(channelId);
  await broadcast((connection) =>
    members && !members.includes(connection.userId) ? null : newMessage,
  );
  return ok();
});
