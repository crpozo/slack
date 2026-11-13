import {
  newMessageSk,
  systemNoteText,
  type Channel,
  type Message,
  type MessageNewEvent,
  type SystemNote,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, listConnections } from "./broadcast";
import { channelAudience } from "./channels";
import { errorFields, log } from "./logger";

// ---------------------------------------------------------------------------
// Phase 63: the line a conversation gets when its members change ("@Luis was
// removed from the channel by Ana"). Written in the same transaction as the
// change (see `saveMembers` in handlers/channel.ts and `inviteToChannel` in
// handlers/tasks.ts), then sent to whoever can see the channel.
// ---------------------------------------------------------------------------

/** The system message for `note`, written by `by` (its `text` uses today's names). */
export function systemMessage(
  channel: Pick<Channel, "channelId">,
  note: SystemNote,
  by: { userId: string; userEmail: string },
  names: Map<string, string>,
  now = Date.now(),
): Message {
  return {
    messageId: ulid(now),
    channelId: channel.channelId,
    sk: newMessageSk(now),
    userId: by.userId,
    userEmail: by.userEmail,
    text: systemNoteText(note, (id) => names.get(id) ?? "someone"),
    attachments: [],
    createdAt: now,
    reactions: {},
    kind: "system",
    system: note,
  };
}

/** Sends the system line to everyone who can see the channel now (best effort). */
export async function announceNote(channel: Channel, note: Message | null): Promise<void> {
  if (!note) return;
  try {
    const audience = (await listConnections()).filter(channelAudience(channel));
    // No sender's tab is waiting on it: a client id no send ever uses.
    const event: MessageNewEvent = {
      type: "message.new",
      message: note,
      clientId: `system:${note.messageId}`,
    };
    await deliver(audience, () => event);
  } catch (err) {
    log.warn("system note not announced", { channelId: channel.channelId, ...errorFields(err) });
  }
}
