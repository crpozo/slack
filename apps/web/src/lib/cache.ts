import type { Channel, Message, ReadMark, UserProfile } from "@mindfultech/shared";
import { createStore, del, get, set } from "idb-keyval";

// ---------------------------------------------------------------------------
// Offline-first start (Phase 23): what the app needs to paint a conversation
// is kept in IndexedDB per user, so opening the app or switching channels
// shows the last known state at once while the server catches us up.
// Secrets and unsent messages are never written; sign-out wipes the user's row.
// ---------------------------------------------------------------------------

/** Bump when the shape changes: an old snapshot is then ignored, not migrated. */
export const SNAPSHOT_VERSION = 1;
/** Newest messages kept per channel (one history page). */
export const CACHED_MESSAGES_PER_CHANNEL = 50;
/** Writes are coalesced: the store changes many times a second while messages flow. */
export const SAVE_DEBOUNCE_MS = 1000;

export interface Snapshot {
  version: number;
  savedAt: number;
  channels: Channel[];
  pinned: string[];
  users: Record<string, UserProfile>;
  directory: Record<string, string>;
  /** Per channel, oldest first, at most `CACHED_MESSAGES_PER_CHANNEL`. */
  messagesByChannel: Record<string, Message[]>;
  /** The cursor to the page before what's cached (`null`: the whole history is there). */
  cursors: Record<string, string | null>;
  reads: Record<string, Record<string, ReadMark>>;
}

let store: ReturnType<typeof createStore> | null | undefined;

/** The IndexedDB store, or `null` where IndexedDB is unavailable (private mode, old WebViews). */
function db(): ReturnType<typeof createStore> | null {
  if (store !== undefined) return store;
  try {
    store = typeof indexedDB === "undefined" ? null : createStore("slack-cache", "snapshots");
  } catch {
    store = null;
  }
  return store;
}

const key = (userId: string) => `snapshot:${userId}`;

/** The user's last snapshot, or `null` (none, unreadable, or an older shape). */
export async function loadSnapshot(userId: string): Promise<Snapshot | null> {
  const s = db();
  if (!s) return null;
  try {
    const raw = await get<Snapshot>(key(userId), s);
    if (!raw || raw.version !== SNAPSHOT_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveSnapshot(userId: string, snapshot: Snapshot): Promise<void> {
  const s = db();
  if (!s) return;
  try {
    await set(key(userId), snapshot, s);
  } catch {
    // Quota, private mode, a closing tab: the next save will try again.
  }
}

export async function clearSnapshot(userId: string): Promise<void> {
  const s = db();
  if (!s) return;
  try {
    await del(key(userId), s);
  } catch {
    // Nothing to do.
  }
}

/** What's safe to keep of a channel's messages: confirmed, not secret, the newest page. */
export function cacheableMessages(messages: Message[]): Message[] {
  return messages
    .filter((m) => !m.isSecret && !("status" in m && m.status))
    .slice(-CACHED_MESSAGES_PER_CHANNEL)
    .map((m) => {
      // Attachments keep their signed URLs: the client checks their expiry before using them.
      const rest = { ...m };
      delete rest.readBy;
      return rest;
    });
}

/**
 * Builds the snapshot of the store's current state. Pure, so it can be tested
 * without IndexedDB; `persist()` below calls it on a debounce.
 */
export function snapshotOf(state: {
  channels: Channel[];
  pinned: string[];
  users: Record<string, UserProfile>;
  directory: Record<string, string>;
  messagesByChannel: Record<string, Message[]>;
  cursors: Record<string, string | null>;
  reads: Record<string, Record<string, ReadMark>>;
}): Snapshot {
  const messagesByChannel: Record<string, Message[]> = {};
  const cursors: Record<string, string | null> = {};
  for (const [channelId, list] of Object.entries(state.messagesByChannel)) {
    const kept = cacheableMessages(list);
    if (kept.length === 0) continue;
    messagesByChannel[channelId] = kept;
    // If we trimmed, the cached page isn't the whole history: no cursor claims otherwise.
    const trimmed = kept.length < list.filter((m) => !("status" in m && m.status)).length;
    const cursor = state.cursors[channelId];
    cursors[channelId] = trimmed ? (cursor ?? null) || "stale" : (cursor ?? null);
  }
  return {
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    channels: state.channels,
    pinned: state.pinned,
    users: state.users,
    directory: state.directory,
    messagesByChannel,
    cursors,
    reads: state.reads,
  };
}

/**
 * Saves `userId`'s snapshot at most once per `SAVE_DEBOUNCE_MS`; the last
 * state wins. Returns a function that cancels a pending save and flushes
 * nothing (the next sign-in loads what was last written).
 */
export function createPersister(userId: string, read: () => Snapshot) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    void saveSnapshot(userId, read());
  };
  return {
    schedule() {
      if (timer === null) timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
