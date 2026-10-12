import type { Message } from "@mindfultech/shared";

/** DynamoDB string sets come back as `Set`s; the wire format uses sorted arrays. */
export function toReactionLists(raw: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [emoji, users] of Object.entries(raw as Record<string, unknown>)) {
    const list = users instanceof Set ? [...users] : Array.isArray(users) ? users : [];
    const ids = list.filter((u): u is string => typeof u === "string").sort();
    if (ids.length > 0) result[emoji] = ids;
  }
  return result;
}

/** A `messages` row as sent to clients. */
export function toWireMessage(item: Record<string, unknown>): Message {
  return { ...(item as unknown as Message), reactions: toReactionLists(item.reactions) };
}
