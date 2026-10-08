import { dmMembers, type Channel } from "@mindfultech/shared";
import type { DirectoryUser } from "./config";

/** Local part of an email, used as display name. */
export function displayName(email: string | undefined): string {
  return email ? (email.split("@")[0] ?? email) : "desconocido";
}

/** The other participant of a DM (yourself for a self-DM), or `null`. */
export function dmPeer(channelId: string, myUserId: string): string | null {
  const members = dmMembers(channelId);
  if (!members) return null;
  return members[0] === myUserId ? members[1] : members[0];
}

/** Sidebar/header label: `general` for channels, the peer's email for DMs. */
export function channelLabel(
  channelId: string,
  channel: Channel | undefined,
  myUserId: string,
  directory: Record<string, string>,
): string {
  const peer = dmPeer(channelId, myUserId);
  if (peer === null) return channel?.name ?? channelId;
  const email = directory[peer];
  if (!email) return "Mensaje directo";
  return peer === myUserId ? `${email} (tú)` : email;
}

export interface DmEntry {
  email: string;
  userId?: string;
  channelId?: string;
}

/**
 * DM list: everyone from VITE_USERS plus anyone with an existing DM channel,
 * with user ids resolved from the directory when VITE_USERS lacks them.
 */
export function dmEntries(
  team: DirectoryUser[],
  channels: Channel[],
  me: { userId: string; email: string },
  directory: Record<string, string>,
  dmIdFor: (userId: string) => string,
): DmEntry[] {
  const idByEmail = new Map(Object.entries(directory).map(([id, email]) => [email, id]));
  const emailById = new Map<string, string>();
  for (const [id, email] of Object.entries(directory)) emailById.set(id, email);
  for (const u of team) if (u.userId) emailById.set(u.userId, u.email);

  // Keyed by user id when known (by email otherwise) so nobody appears twice.
  const entries = new Map<string, DmEntry>();
  for (const user of team) {
    if (user.email === me.email.toLowerCase()) continue;
    const userId = user.userId ?? idByEmail.get(user.email);
    entries.set(userId ?? user.email, { email: user.email, userId });
  }
  for (const channel of channels) {
    if (channel.type !== "dm") continue;
    const peer = dmPeer(channel.channelId, me.userId);
    if (!peer || peer === me.userId || entries.has(peer)) continue;
    entries.set(peer, { email: emailById.get(peer) ?? "Mensaje directo", userId: peer });
  }

  const dmIds = new Set(channels.filter((c) => c.type === "dm").map((c) => c.channelId));
  return [...entries.values()]
    .map((e) => {
      const id = e.userId ? dmIdFor(e.userId) : undefined;
      return { ...e, channelId: id && dmIds.has(id) ? id : undefined };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

const timeFormat = new Intl.DateTimeFormat("es", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayFormat = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" });

export function formatTime(ts: number): string {
  return timeFormat.format(ts);
}

export function formatDay(ts: number, now: number = Date.now()): string {
  const day = new Date(ts).toDateString();
  if (day === new Date(now).toDateString()) return "Hoy";
  if (day === new Date(now - 86_400_000).toDateString()) return "Ayer";
  const label = dayFormat.format(ts);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Normalizes user input into a valid channel name (`^[a-z0-9-]{1,32}$`). */
export function normalizeChannelName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^#/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}
