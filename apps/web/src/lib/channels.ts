import { dmMembers, type Channel, type UserProfile } from "@mindfultech/shared";
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
