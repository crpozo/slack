// ---------------------------------------------------------------------------
// Recent conversations (Phase 37): the phone header's history button. A short,
// device-local stack of the channels and DMs opened last, per account; never
// sent anywhere.
// ---------------------------------------------------------------------------

export const MAX_RECENTS = 15;

export interface RecentVisit {
  channelId: string;
  at: number;
}

const key = (userId: string) => `slack.recents.${userId}`;

/** `channelId` on top, without duplicates, at most `MAX_RECENTS`. */
export function pushRecent(list: RecentVisit[], channelId: string, at: number): RecentVisit[] {
  return [{ channelId, at }, ...list.filter((r) => r.channelId !== channelId)].slice(
    0,
    MAX_RECENTS,
  );
}

function isVisit(value: unknown): value is RecentVisit {
  const v = value as RecentVisit | null;
  return !!v && typeof v.channelId === "string" && typeof v.at === "number";
}

export function loadRecents(userId: string): RecentVisit[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isVisit).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export function recordVisit(userId: string, channelId: string, at = Date.now()): void {
  try {
    localStorage.setItem(
      key(userId),
      JSON.stringify(pushRecent(loadRecents(userId), channelId, at)),
    );
  } catch {
    // Blocked storage: no history on this device.
  }
}

export function forgetRecents(userId: string): void {
  try {
    localStorage.removeItem(key(userId));
  } catch {
    // Nothing stored.
  }
}
