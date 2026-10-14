import { GetCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import {
  findMentions,
  isChannelMember,
  mentionHandle,
  PUSH_PREVIEW_LENGTH,
  type Channel,
  type Message,
  type PushPayload,
} from "@mindfultech/shared";
import { dmPeerOf } from "./channels";
import { ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";
import { sendPush } from "./push";
import { defaultDisplayName, toUserProfile } from "./users";

/** Everyone in the directory (a handful of rows), only read when a message mentions someone. */
async function scanUsers() {
  const users = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.users })) {
    users.push(...(page.Items ?? []).map(toUserProfile));
  }
  return users;
}

async function displayNameOf(userId: string, email: string): Promise<string> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.users,
      Key: { userId },
      ProjectionExpression: "displayName",
    }),
  );
  return typeof Item?.displayName === "string" ? Item.displayName : defaultDisplayName(email);
}

/**
 * Who should hear about `message` beyond the open sockets: the other person
 * of a DM, or the channel members it `@mentions` (by display name without
 * spaces, or by email local part). Never the sender.
 */
export async function pushRecipients(channel: Channel, message: Message): Promise<string[]> {
  if (channel.type === "dm") {
    const peer = dmPeerOf(channel, message.userId);
    return peer ? [peer] : [];
  }
  const handles = new Set(findMentions(message.text));
  if (handles.size === 0) return [];
  const users = await scanUsers();
  return users
    .filter(
      (u) =>
        u.userId !== message.userId &&
        isChannelMember(channel, u.userId) &&
        (handles.has(mentionHandle(u.displayName)) ||
          handles.has(defaultDisplayName(u.email).toLowerCase())),
    )
    .map((u) => u.userId);
}

function preview(message: Message): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text) {
    if (message.attachments.some((a) => a.contentType.startsWith("audio/")))
      return "🎤 Voice message";
    return message.attachments.length > 0 ? "📎 Sent a file" : "New message";
  }
  return text.length > PUSH_PREVIEW_LENGTH
    ? `${text.slice(0, PUSH_PREVIEW_LENGTH - 1).trimEnd()}…`
    : text;
}

/**
 * Pushes `message` to its recipients who have no live WebSocket connection
 * (`liveUserIds`). Best effort: never throws, never delays a failure into the
 * sender's reply.
 */
export async function notifyOffline(
  channel: Channel,
  message: Message,
  liveUserIds: Set<string>,
): Promise<void> {
  try {
    const offline = (await pushRecipients(channel, message)).filter((id) => !liveUserIds.has(id));
    if (offline.length === 0) return;
    const sender = await displayNameOf(message.userId, message.userEmail);
    const payload: PushPayload = {
      title: channel.type === "dm" ? sender : `${sender} in #${channel.name}`,
      body: preview(message),
      url: `/app/${encodeURIComponent(channel.channelId)}`,
      tag: channel.channelId,
      sound: "default",
    };
    const sent = await sendPush(offline, payload);
    log.info("offline recipients notified", {
      channelId: channel.channelId,
      recipients: offline.length,
      sent,
    });
  } catch (err) {
    log.error("offline notification failed", { channelId: channel.channelId, ...errorFields(err) });
  }
}
