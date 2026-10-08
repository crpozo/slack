import type { Message } from "@mindfultech/shared";

export type DeliveryStatus = "pending" | "failed";

/** A message as the UI holds it: optimistic ones carry a `status`. */
export interface ChatMessage extends Message {
  clientId?: string;
  status?: DeliveryStatus;
}

/** Sorts pending/failed messages after every confirmed one. */
function sortKey(m: ChatMessage): string {
  return m.status ? `~${m.createdAt}` : m.sk;
}

/**
 * Merges `incoming` into `existing`: dedupes by `messageId`, replaces optimistic
 * messages that the server confirmed (same `clientId`) and keeps everything in
 * chronological order.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const confirmedClientIds = new Set(
    incoming.filter((m) => !m.status && m.clientId).map((m) => m.clientId),
  );
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) {
    if (m.status && confirmedClientIds.has(m.clientId)) continue;
    byId.set(m.messageId, m);
  }
  for (const m of incoming) byId.set(m.messageId, m);
  return [...byId.values()].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
}

export function pendingMessageId(clientId: string): string {
  return `pending:${clientId}`;
}

/** Messages from other people newer than `lastRead`. */
export function countUnread(messages: ChatMessage[], lastRead: number, myUserId: string): number {
  let count = 0;
  for (const m of messages) {
    if (!m.status && m.userId !== myUserId && m.createdAt > lastRead) count++;
  }
  return count;
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Whether `m` continues the previous message's group (same author, < 5 min, same day). */
export function isGroupedWith(prev: ChatMessage | undefined, m: ChatMessage): boolean {
  return (
    !!prev &&
    prev.userId === m.userId &&
    m.createdAt - prev.createdAt < GROUP_WINDOW_MS &&
    new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString()
  );
}
