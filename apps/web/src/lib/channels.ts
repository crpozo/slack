import { dmMembers, GENERAL_CHANNEL_ID, type Channel, type UserProfile } from "@mindfultech/shared";
import type { DirectoryUser } from "./config";

/** Local part of an email, used as display name. */
export function displayName(email: string | undefined): string {
  return email ? email.split("@")[0] || email : "unknown";
}

/** The other participant of a DM (yourself for a self-DM), or `null`. */
export function dmPeer(channelId: string, myUserId: string): string | null {
  const members = dmMembers(channelId);
  if (!members) return null;
  return members[0] === myUserId ? members[1] : members[0];
}

/** Sidebar/header label: `general` for channels, the peer's display name for DMs. */
export function channelLabel(
  channelId: string,
  channel: Channel | undefined,
  myUserId: string,
  nameOf: (userId: string) => string | undefined,
): string {
  const peer = dmPeer(channelId, myUserId);
  if (peer === null) return channel?.name ?? channelId;
  const name = nameOf(peer);
  if (!name) return "Direct message";
  return peer === myUserId ? `${name} (you)` : name;
}

export interface DmEntry {
  email: string;
  /** Display name, falling back to the local part of the email. */
  name: string;
  userId?: string;
  channelId?: string;
}

type PendingEntry = Omit<DmEntry, "name">;

/** Known emails by user id: VITE_USERS first, overridden by the team list. */
function emailsById(team: DirectoryUser[], directory: Record<string, string>): Map<string, string> {
  const emailById = new Map(Object.entries(directory));
  for (const u of team) if (u.userId) emailById.set(u.userId, u.email);
  return emailById;
}

/** Adds the people in `team` not already in `entries` (keyed by user id, or email if unknown). */
function addTeam(
  entries: Map<string, PendingEntry>,
  team: DirectoryUser[],
  me: { email: string },
  directory: Record<string, string>,
): void {
  const idByEmail = new Map(Object.entries(directory).map(([id, email]) => [email, id]));
  for (const user of team) {
    if (user.email === me.email.toLowerCase()) continue;
    const userId = user.userId ?? idByEmail.get(user.email);
    if (userId && entries.has(userId)) continue;
    entries.set(userId ?? user.email, { email: user.email, userId });
  }
}

/** Adds the peers of existing DM channels not already in `entries`. */
function addDmPeers(
  entries: Map<string, PendingEntry>,
  channels: Channel[],
  myUserId: string,
  emailById: Map<string, string>,
): void {
  for (const channel of channels) {
    if (channel.type !== "dm") continue;
    const peer = dmPeer(channel.channelId, myUserId);
    if (!peer || peer === myUserId || entries.has(peer)) continue;
    entries.set(peer, { email: emailById.get(peer) ?? "Direct message", userId: peer });
  }
}

/**
 * DM list: everyone in the server directory (`user.list`), plus VITE_USERS and
 * anyone with an existing DM channel, never listing the same person twice.
 */
export function dmEntries(
  team: DirectoryUser[],
  channels: Channel[],
  me: { userId: string; email: string },
  directory: Record<string, string>,
  dmIdFor: (userId: string) => string,
  profiles: Record<string, UserProfile> = {},
): DmEntry[] {
  // Keyed by user id when known (by email otherwise) so nobody appears twice.
  const entries = new Map<string, PendingEntry>();
  for (const profile of Object.values(profiles)) {
    if (profile.userId === me.userId) continue;
    entries.set(profile.userId, { email: profile.email, userId: profile.userId });
  }
  addTeam(entries, team, me, directory);
  addDmPeers(entries, channels, me.userId, emailsById(team, directory));
  // Guests (external board collaborators) can't chat: never offer a DM with them.
  for (const profile of Object.values(profiles)) {
    if (profile.role === "guest") entries.delete(profile.userId);
  }

  const dmIds = new Set(channels.filter((c) => c.type === "dm").map((c) => c.channelId));
  return [...entries.values()]
    .map((e) => {
      const id = e.userId ? dmIdFor(e.userId) : undefined;
      const name = (e.userId && profiles[e.userId]?.displayName) || displayName(e.email);
      return { ...e, name, channelId: id && dmIds.has(id) ? id : undefined };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const timeFormat = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayFormat = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long" });

export function formatTime(ts: number): string {
  return timeFormat.format(ts);
}

export function formatDay(ts: number, now: number = Date.now()): string {
  const day = new Date(ts).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  const label = dayFormat.format(ts);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "Seen by Ana", "Seen by Ana and Luis", "Seen by Ana, Luis and 3 others". */
export function seenByLine(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `Seen by ${names[0]}`;
  if (names.length === 2) return `Seen by ${names[0]} and ${names[1]}`;
  if (names.length === 3) return `Seen by ${names[0]}, ${names[1]} and ${names[2]}`;
  const rest = names.length - 2;
  return `Seen by ${names[0]}, ${names[1]} and ${rest} others`;
}

/** Pinned conversations first (most recent pin first), then the rest as they were. */
export function pinnedFirst<T extends { channelId?: string }>(entries: T[], pinned: string[]): T[] {
  const rank = new Map(pinned.map((id, i) => [id, i]));
  const isPinned = (e: T) => e.channelId !== undefined && rank.has(e.channelId);
  const top = entries
    .filter(isPinned)
    .sort((a, b) => (rank.get(a.channelId ?? "") ?? 0) - (rank.get(b.channelId ?? "") ?? 0));
  return [...top, ...entries.filter((e) => !isPinned(e))];
}

// ---------------------------------------------------------------------------
// Priority chats (Phase 24): conversations ordered by their latest message.
// ---------------------------------------------------------------------------

/** When a conversation last moved: its newest message, else its creation. */
export const activityOf = (c: Pick<Channel, "lastMessageAt" | "createdAt">): number =>
  c.lastMessageAt ?? c.createdAt;

/** Most recent activity first; ties by name, so the order is stable. */
function byActivity(a: Channel, b: Channel): number {
  return activityOf(b) - activityOf(a) || a.name.localeCompare(b.name);
}

/** `#general` pinned on top, then the rest by recent activity. Pure: a new array. */
export function orderChannels(channels: Channel[]): Channel[] {
  return [...channels].sort((a, b) => {
    if (a.channelId === GENERAL_CHANNEL_ID) return -1;
    if (b.channelId === GENERAL_CHANNEL_ID) return 1;
    return byActivity(a, b);
  });
}

/**
 * The DM list: pinned chats first (in pin order), then conversations by
 * recent activity, then the people you've never written to, in the
 * alphabetical order `entries` came in.
 */
export function orderDms(entries: DmEntry[], channels: Channel[], pinned: string[]): DmEntry[] {
  const at = new Map(channels.map((c) => [c.channelId, activityOf(c)]));
  const rank = new Map(pinned.map((id, i) => [id, i]));
  const pinnedRank = (e: DmEntry) =>
    e.channelId === undefined ? undefined : rank.get(e.channelId);
  const activity = (e: DmEntry) => (e.channelId === undefined ? undefined : at.get(e.channelId));
  const top = entries
    .filter((e) => pinnedRank(e) !== undefined)
    .sort((a, b) => pinnedRank(a)! - pinnedRank(b)!);
  const rest = entries.filter((e) => pinnedRank(e) === undefined);
  const active = rest
    .filter((e) => activity(e) !== undefined)
    .sort((a, b) => activity(b)! - activity(a)!);
  const quiet = rest.filter((e) => activity(e) === undefined);
  return [...top, ...active, ...quiet];
}
