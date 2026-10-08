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

/** Id for a new public channel: `ch_<ulid>`. */
export function newChannelId(): string {
  return `ch_${ulid()}`;
}

/** Message sort key: `${epochMs}#${ulid}` — sorts chronologically. */
export function newMessageSk(now: number = Date.now()): string {
  return `${now}#${ulid(now)}`;
}
