import { ulid } from "ulid";

export const GENERAL_CHANNEL_ID = "ch_general";

const DM_PREFIX = "dm_";

/** Deterministic DM channel id: same result regardless of argument order. */
export function dmChannelId(userIdA: string, userIdB: string): string {
  const [first, second] = [userIdA, userIdB].sort();
  return `${DM_PREFIX}${first}_${second}`;
}

export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith(DM_PREFIX);
}

/**
 * Participants of a DM channel id, or `null` if `channelId` is not a DM.
 * Relies on user ids (Cognito `sub` UUIDs) never containing `_`.
 */
export function dmMembers(channelId: string): [string, string] | null {
  if (!isDmChannel(channelId)) return null;
  const parts = channelId.slice(DM_PREFIX.length).split("_");
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

/** Whether `userId` may read/write `channelId`: public channels are open to everyone. */
export function canAccessChannel(channelId: string, userId: string): boolean {
  const members = dmMembers(channelId);
  return members === null ? !isDmChannel(channelId) : members.includes(userId);
}

/** Id for a new public channel: `ch_<ulid>`. */
export function newChannelId(): string {
  return `ch_${ulid()}`;
}

/** Message sort key: `${epochMs}#${ulid}` — sorts chronologically. */
export function newMessageSk(now: number = Date.now()): string {
  return `${now}#${ulid(now)}`;
}
