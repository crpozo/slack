import { GetCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import {
  describeTaskActivity,
  findMentions,
  isChannelMember,
  mentionHandle,
  PUSH_PREVIEW_LENGTH,
  SECRET_PREVIEW,
  type Board,
  type Channel,
  type Message,
  type PushPayload,
  type Task,
  type TaskStatus,
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

export async function displayNameOf(userId: string, email: string): Promise<string> {
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
 * of a DM; every other member of a private channel (a small group, like a
 * DM); in a public channel, the members it `@mentions` (by display name
 * without spaces, or by email local part). Never the sender.
 */
export async function pushRecipients(channel: Channel, message: Message): Promise<string[]> {
  if (channel.type === "dm") {
    const peer = dmPeerOf(channel, message.userId);
    return peer ? [peer] : [];
  }
  if (channel.type === "private") {
    return [...new Set(channel.members ?? [])].filter((id) => id !== message.userId);
  }
  const handles = new Set(findMentions(message.text));
  if (handles.size === 0) return [];
  const users = await scanUsers();
  return users
    .filter(
      (u) =>
        u.userId !== message.userId &&
        u.role !== "guest" && // a guest never sees channels, so never their previews
        isChannelMember(channel, u.userId) &&
        (handles.has(mentionHandle(u.displayName)) ||
          handles.has(defaultDisplayName(u.email).toLowerCase())),
    )
    .map((u) => u.userId);
}

function preview(message: Message): string {
  if (message.isSecret) return `${SECRET_PREVIEW} sent`;
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
 * Pushes `message` to its recipients who aren't in front of the app right now
 * (not in `activeUserIds`, see `ACTIVE_WINDOW_MS`). Best effort: never throws,
 * never delays a failure into the sender's reply.
 */
export async function notifyOffline(
  channel: Channel,
  message: Message,
  activeUserIds: Set<string>,
): Promise<void> {
  try {
    const offline = (await pushRecipients(channel, message)).filter((id) => !activeUserIds.has(id));
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

/**
 * Pushes a board change (a new task, or a task moved to another column) to the
 * board's members other than `actor` who aren't in front of the app right now.
 * Best effort, like `notifyOffline`.
 */
export async function notifyTaskActivity(
  board: Board,
  actor: { userId: string; email: string },
  task: Task,
  previousStatus: TaskStatus | undefined,
  activeUserIds: Set<string>,
): Promise<void> {
  try {
    const recipients = [...new Set([board.ownerId, ...board.members])].filter(
      (id) => id !== actor.userId && !activeUserIds.has(id),
    );
    if (recipients.length === 0) return;
    const actorName = await displayNameOf(actor.userId, actor.email);
    const { title, body } = describeTaskActivity({
      actorName,
      boardName: board.name,
      task,
      previousStatus,
    });
    const sent = await sendPush(recipients, {
      title,
      body,
      url: `/app/tasks/${encodeURIComponent(board.boardId)}`,
      // One notification per task: its later moves replace the earlier ones.
      tag: task.taskId,
      sound: "default",
    });
    log.info("board members notified", {
      boardId: board.boardId,
      taskId: task.taskId,
      recipients: recipients.length,
      sent,
    });
  } catch (err) {
    log.error("board notification failed", { boardId: board.boardId, ...errorFields(err) });
  }
}
