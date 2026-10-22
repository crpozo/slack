import {
  isThreadSk,
  type AiNotes,
  type Channel,
  type MeetingCard,
  type Message,
  type MessageThreadUpdatedEvent,
  type ReadMark,
  type ReplySnapshot,
  type UserProfile,
} from "@mindfultech/shared";
import type { Snapshot } from "../lib/cache";
import { useCallback } from "react";
import { create } from "zustand";
import type { SessionUser } from "../lib/auth";
import { displayName } from "../lib/channels";
import { loadOwnProfile, saveOwnProfile } from "../lib/profile";
import type { DirectoryUser } from "../lib/config";
import type { WsStatus } from "../lib/ws";
import { countUnreadAfter, mergeMessages, pendingMessageId, type ChatMessage } from "./messages";

export type { ChatMessage } from "./messages";

type HistoryRequest = "initial" | "older";

/** A message of yours being edited: its key and the text the composer starts from. */
export interface EditTarget {
  sk: string;
  messageId: string;
  text: string;
}

export interface ChatState {
  me: SessionUser | null;
  status: WsStatus;
  channels: Channel[];
  /** Your pinned conversations (DMs), most recent pin first; synced across your devices. */
  pinned: string[];
  /** Channel list received at least once since connecting. */
  channelsLoaded: boolean;
  activeChannelId: string | null;
  messagesByChannel: Record<string, ChatMessage[]>;
  /** Cursor for the next older page: absent = never loaded, `null` = no more pages. */
  cursors: Record<string, string | null>;
  historyRequests: Record<string, HistoryRequest | undefined>;
  /**
   * Unread messages per channel: seeded by the server's counts (`channel.list`
   * on connect), +1 for each new message from someone else you aren't looking
   * at, 0 once you look. The same on every device: they all count from your
   * read mark.
   */
  unread: Record<string, number>;
  /** Public channels with an unread @mention of you (their badge turns red). */
  mentioned: Record<string, true>;
  /** userId → email for everyone we know about. */
  directory: Record<string, string>;
  /** Users from VITE_USERS (optional fallback for the DM list). */
  team: DirectoryUser[];
  /** Server directory (`user.list` / `user.updated`), keyed by userId. */
  users: Record<string, UserProfile>;
  /** Presence: users with at least one live connection (`user.connected` / `user.disconnected`). */
  online: Record<string, true>;
  /** Per-channel pending reply (the composer's "Replying to…" banner). */
  replyTo: Record<string, ReplySnapshot>;
  /** Per-channel message being edited in the composer. */
  editing: Record<string, EditTarget | undefined>;
  /** Read watermarks per channel, per user (from `channel.list`, kept current by `channel.read`). */
  reads: Record<string, Record<string, ReadMark>>;
  /** Who is typing per channel: userId → epoch ms when the indicator expires. */
  typing: Record<string, Record<string, number>>;
  /** The active channel's message list is scrolled to the bottom (new messages count as seen). */
  listAtBottom: boolean;
  toast: string | null;
  /**
   * Channels whose cached history may be behind the server (loaded from the
   * offline cache, or kept across a reconnect): shown at once, refreshed on open.
   */
  stale: Record<string, true>;
  /** The offline cache was applied (or there was none): the shell can stop waiting. */
  hydrated: boolean;
  /** Thread replies by the parent's sort key, oldest first; absent until loaded. */
  threads: Record<string, ChatMessage[]>;
  /** Per thread: cursor to older replies (`null`: all loaded). */
  threadCursors: Record<string, string | null>;
  threadRequests: Record<string, HistoryRequest | undefined>;

  setSession: (me: SessionUser | null, team?: DirectoryUser[]) => void;
  setStatus: (status: WsStatus) => void;
  /** `unread`: the server's counts, when the list carries them (replaces ours). */
  setChannels: (channels: Channel[], unread?: Record<string, number>) => void;
  /** `channel.updated` (renamed): replaces the row, keeping everything else. */
  updateChannel: (channel: Channel) => void;
  setPinned: (pinned: string[]) => void;
  setActiveChannel: (channelId: string | null) => void;
  historyRequested: (channelId: string, kind: HistoryRequest) => void;
  receiveHistory: (channelId: string, items: Message[], nextCursor: string | null) => void;
  receiveMessage: (message: Message, clientId?: string) => void;
  addPending: (message: ChatMessage) => void;
  setPendingStatus: (channelId: string, clientId: string, status: "pending" | "failed") => void;
  /** `online` replaces the presence snapshot when given. */
  setUsers: (users: UserProfile[], online?: string[]) => void;
  setPresence: (userId: string, online: boolean) => void;
  /** Starts (or, with `null`, cancels) a reply in `channelId`. */
  setReplyTo: (channelId: string, reply: ReplySnapshot | null) => void;
  /** A channel or DM was deleted: forget it and everything cached for it. */
  removeChannel: (channelId: string) => void;
  upsertUser: (user: UserProfile) => void;
  setReactions: (channelId: string, sk: string, reactions: Record<string, string[]>) => void;
  /** `message.updated`: the author changed the text. */
  applyEdit: (channelId: string, sk: string, text: string, editedAt: number) => void;
  /** `message.updated` with a card: the meeting was edited in the calendar. */
  updateMeetingCard: (channelId: string, sk: string, meeting: MeetingCard, text: string) => void;
  /** A ✨ AI notes card moved on (pending → ready or failed); not an edit. */
  updateAiNotes: (channelId: string, sk: string, aiNotes: AiNotes, text: string) => void;
  /** Starts (or, with `null`, ends) editing a message in `channelId`'s composer. */
  setEditing: (channelId: string, target: EditTarget | null) => void;
  setReadMark: (channelId: string, userId: string, mark: ReadMark) => void;
  /** `until`: when the indicator expires; `null` clears it. */
  setTyping: (channelId: string, userId: string, until: number | null) => void;
  setListAtBottom: (atBottom: boolean) => void;
  /** A new message from someone else arrived where you aren't looking. */
  bumpUnread: (channelId: string, mention?: boolean) => void;
  /** You are looking at `channelId`: nothing in it is unread. */
  markRead: (channelId: string) => void;
  /** Your read mark moved (e.g. you read it on another device): recount from it. */
  recountUnread: (channelId: string, sk: string) => void;
  /** After a reconnect: cached history of inactive channels is kept but refreshed on open. */
  invalidateInactive: () => void;
  showToast: (message: string | null) => void;
  /** Applies the offline snapshot (everything in it is `stale` until the server confirms it). */
  hydrate: (snapshot: Snapshot | null) => void;
  threadRequested: (parentSk: string, kind: HistoryRequest) => void;
  receiveThreadHistory: (parentSk: string, items: Message[], nextCursor: string | null) => void;
  /** `message.thread_updated`: the parent's counters. */
  applyThreadUpdate: (event: MessageThreadUpdatedEvent) => void;
}

/** Same people with the same profiles (by value), so a refresh needn't re-render everything. */
export function sameUsers(a: Record<string, UserProfile>, b: Record<string, UserProfile>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => {
    const x = a[id];
    const y = b[id];
    return (
      !!x &&
      !!y &&
      x.email === y.email &&
      x.displayName === y.displayName &&
      x.updatedAt === y.updatedAt &&
      x.role === y.role
    );
  });
}

function learnAuthors(directory: Record<string, string>, messages: Message[]) {
  let next = directory;
  for (const m of messages) {
    if (next[m.userId] !== m.userEmail) next = { ...next, [m.userId]: m.userEmail };
  }
  return next;
}

const initialState = {
  me: null,
  status: "idle" as WsStatus,
  channels: [],
  pinned: [] as string[],
  channelsLoaded: false,
  activeChannelId: null,
  messagesByChannel: {},
  cursors: {},
  historyRequests: {},
  unread: {} as Record<string, number>,
  mentioned: {} as Record<string, true>,
  directory: {},
  team: [],
  users: {},
  online: {},
  replyTo: {},
  editing: {},
  reads: {},
  typing: {},
  listAtBottom: true,
  toast: null,
  stale: {} as Record<string, true>,
  hydrated: false,
  threads: {} as Record<string, ChatMessage[]>,
  threadCursors: {} as Record<string, string | null>,
  threadRequests: {} as Record<string, HistoryRequest | undefined>,
};

/** The parent's sort key encoded in a reply's (`thread#<parentSk>#<epoch>#<ulid>`). */
export function parentSkOf(sk: string): string | null {
  if (!isThreadSk(sk)) return null;
  const parts = sk.split("#"); // ["thread", epoch, ulid, epoch, ulid]
  return parts.length >= 5 ? `${parts[1]}#${parts[2]}` : null;
}

/** Patches the message with `sk` wherever it lives: the channel list or a thread. */
/**
 * `channelId`'s `lastMessageAt` moved to `at` (only forward): the same array
 * when nothing changes, so the sidebar doesn't re-sort for nothing.
 */
function touchChannel(channels: Channel[], channelId: string, at: number): Channel[] {
  const i = channels.findIndex((c) => c.channelId === channelId);
  const channel = channels[i];
  if (!channel || (channel.lastMessageAt ?? 0) >= at) return channels;
  const next = [...channels];
  next[i] = { ...channel, lastMessageAt: at };
  return next;
}

function patchMessage(
  s: Pick<ChatState, "messagesByChannel" | "threads">,
  channelId: string,
  sk: string,
  patch: (m: ChatMessage) => ChatMessage,
): Partial<ChatState> {
  const parentSk = parentSkOf(sk);
  if (parentSk) {
    const replies = s.threads[parentSk];
    if (!replies?.some((m) => m.sk === sk)) return {};
    return {
      threads: { ...s.threads, [parentSk]: replies.map((m) => (m.sk === sk ? patch(m) : m)) },
    };
  }
  const messages = s.messagesByChannel[channelId];
  if (!messages?.some((m) => m.sk === sk)) return {};
  return {
    messagesByChannel: {
      ...s.messagesByChannel,
      [channelId]: messages.map((m) => (m.sk === sk ? patch(m) : m)),
    },
  };
}

/** The watermarks carried by the channel rows, replacing what we had for those channels. */
function readsOf(
  channels: Channel[],
  previous: Record<string, Record<string, ReadMark>>,
): Record<string, Record<string, ReadMark>> {
  const next = { ...previous };
  for (const c of channels) if (c.reads) next[c.channelId] = c.reads;
  return next;
}

export const useChat = create<ChatState>()((set, get) => ({
  ...initialState,

  setSession: (me, team = []) => {
    const directory: Record<string, string> = {};
    for (const u of team) if (u.userId) directory[u.userId] = u.email;
    if (me) directory[me.userId] = me.email;
    // Your saved profile: your display name shows before the directory arrives.
    const own = me ? loadOwnProfile(me.userId) : null;
    set({
      ...initialState,
      me,
      team,
      directory,
      users: own ? { [own.userId]: own } : {},
    });
  },

  setStatus: (status) => set({ status }),

  setChannels: (channels, unread) =>
    set((s) => ({
      channels,
      channelsLoaded: true,
      reads: readsOf(channels, s.reads),
      ...(unread && {
        unread: { ...unread },
        mentioned: Object.fromEntries(
          Object.keys(s.mentioned)
            .filter((id) => unread[id])
            .map((id) => [id, true as const]),
        ),
      }),
    })),

  updateChannel: (channel) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.channelId === channel.channelId ? channel : c)),
    })),

  setPinned: (pinned) => set({ pinned }),

  setActiveChannel: (activeChannelId) => set({ activeChannelId }),

  historyRequested: (channelId, kind) =>
    set((s) => ({ historyRequests: { ...s.historyRequests, [channelId]: kind } })),

  receiveHistory: (channelId, items, nextCursor) =>
    set((s) => {
      const request = s.historyRequests[channelId];
      const existing = s.messagesByChannel[channelId] ?? [];
      // A refresh of the newest page must not lose the cursor to older pages
      // (unless it's the cache's "there's more, but we don't know where" mark).
      const keepCursor =
        request === "initial" &&
        channelId in s.cursors &&
        s.cursors[channelId] !== "stale" &&
        existing.length > 0;
      const stale = { ...s.stale };
      delete stale[channelId];
      return {
        messagesByChannel: { ...s.messagesByChannel, [channelId]: mergeMessages(existing, items) },
        cursors: keepCursor ? s.cursors : { ...s.cursors, [channelId]: nextCursor },
        historyRequests: { ...s.historyRequests, [channelId]: undefined },
        directory: learnAuthors(s.directory, items),
        stale,
      };
    }),

  receiveMessage: (message, clientId) =>
    set((s) => {
      // The conversation jumps to the top of the sidebar at once (replies count too).
      const channels = touchChannel(s.channels, message.channelId, message.createdAt);
      const parentSk = message.parentSk ?? parentSkOf(message.sk);
      if (parentSk) {
        // A reply: into its thread (only if that thread is loaded; the parent's
        // counters, pushed separately, tell everyone else about it).
        const replies = s.threads[parentSk];
        if (!replies) return { channels, directory: learnAuthors(s.directory, [message]) };
        return {
          channels,
          threads: { ...s.threads, [parentSk]: mergeMessages(replies, [{ ...message, clientId }]) },
          directory: learnAuthors(s.directory, [message]),
        };
      }
      return {
        channels,
        messagesByChannel: {
          ...s.messagesByChannel,
          [message.channelId]: mergeMessages(s.messagesByChannel[message.channelId] ?? [], [
            { ...message, clientId },
          ]),
        },
        directory: learnAuthors(s.directory, [message]),
      };
    }),

  addPending: (message) =>
    set((s) => {
      const channels = touchChannel(s.channels, message.channelId, message.createdAt);
      if (message.parentSk) {
        return {
          channels,
          threads: {
            ...s.threads,
            [message.parentSk]: mergeMessages(s.threads[message.parentSk] ?? [], [message]),
          },
        };
      }
      return {
        channels,
        messagesByChannel: {
          ...s.messagesByChannel,
          [message.channelId]: mergeMessages(s.messagesByChannel[message.channelId] ?? [], [
            message,
          ]),
        },
      };
    }),

  setPendingStatus: (channelId, clientId, status) =>
    set((s) => {
      const id = pendingMessageId(clientId);
      const flag = (m: ChatMessage) => (m.messageId === id ? { ...m, status } : m);
      const messages = s.messagesByChannel[channelId];
      if (messages?.some((m) => m.messageId === id)) {
        return {
          messagesByChannel: { ...s.messagesByChannel, [channelId]: messages.map(flag) },
        };
      }
      const parentSk = Object.keys(s.threads).find((k) =>
        s.threads[k]!.some((m) => m.messageId === id),
      );
      if (!parentSk) return {};
      return { threads: { ...s.threads, [parentSk]: s.threads[parentSk]!.map(flag) } };
    }),

  setUsers: (list, onlineIds) =>
    set((s) => {
      let users: Record<string, UserProfile> = {};
      let directory = s.directory;
      for (const u of list) {
        users[u.userId] = u;
        if (directory[u.userId] !== u.email) directory = { ...directory, [u.userId]: u.email };
      }
      const mine = s.me && users[s.me.userId];
      if (mine) saveOwnProfile(mine);
      // A guest's directory may not list them yet: keep what we know about ourselves.
      else if (s.me && s.users[s.me.userId]) users[s.me.userId] = s.users[s.me.userId]!;
      // The periodic refresh usually brings the same people: keep the object (and
      // everything derived from it, like every message's name) as it was.
      if (sameUsers(s.users, users)) users = s.users;
      if (!onlineIds) return { users, directory };
      const online: Record<string, true> = {};
      for (const id of onlineIds) online[id] = true;
      return { users, directory, online };
    }),

  setPresence: (userId, isOnline) =>
    set((s) => {
      if (!!s.online[userId] === isOnline) return {};
      const online = { ...s.online };
      if (isOnline) online[userId] = true;
      else delete online[userId];
      return { online };
    }),

  setReplyTo: (channelId, reply) =>
    set((s) => {
      const replyTo = { ...s.replyTo };
      if (reply) replyTo[channelId] = reply;
      else delete replyTo[channelId];
      return { replyTo };
    }),

  removeChannel: (channelId) =>
    set((s) => {
      const omit = <T>(record: Record<string, T>) => {
        if (!(channelId in record)) return record;
        const next = { ...record };
        delete next[channelId];
        return next;
      };
      return {
        channels: s.channels.filter((c) => c.channelId !== channelId),
        messagesByChannel: omit(s.messagesByChannel),
        cursors: omit(s.cursors),
        historyRequests: omit(s.historyRequests),
        replyTo: omit(s.replyTo),
        editing: omit(s.editing),
        reads: omit(s.reads),
        typing: omit(s.typing),
        stale: omit(s.stale),
        threads: Object.fromEntries(
          Object.entries(s.threads).filter(([, list]) => list[0]?.channelId !== channelId),
        ),
      };
    }),

  upsertUser: (user) =>
    set((s) => {
      if (user.userId === s.me?.userId) saveOwnProfile(user);
      return {
        users: { ...s.users, [user.userId]: user },
        directory: { ...s.directory, [user.userId]: user.email },
      };
    }),

  setReactions: (channelId, sk, reactions) =>
    set((s) => patchMessage(s, channelId, sk, (m) => ({ ...m, reactions }))),

  applyEdit: (channelId, sk, text, editedAt) =>
    set((s) => patchMessage(s, channelId, sk, (m) => ({ ...m, text, isEdited: true, editedAt }))),

  updateMeetingCard: (channelId, sk, meeting, text) =>
    set((s) => patchMessage(s, channelId, sk, (m) => ({ ...m, meeting, text }))),

  updateAiNotes: (channelId, sk, aiNotes, text) =>
    set((s) => patchMessage(s, channelId, sk, (m) => ({ ...m, aiNotes, text }))),

  setEditing: (channelId, target) =>
    set((s) => ({ editing: { ...s.editing, [channelId]: target ?? undefined } })),

  setReadMark: (channelId, userId, mark) =>
    set((s) => {
      const current = s.reads[channelId]?.[userId];
      if (current && current.sk >= mark.sk) return {};
      return { reads: { ...s.reads, [channelId]: { ...s.reads[channelId], [userId]: mark } } };
    }),

  setTyping: (channelId, userId, until) =>
    set((s) => {
      const next = { ...s.typing[channelId] };
      if (until === null) delete next[userId];
      else next[userId] = until;
      return { typing: { ...s.typing, [channelId]: next } };
    }),

  setListAtBottom: (listAtBottom) => {
    if (get().listAtBottom !== listAtBottom) set({ listAtBottom });
  },

  bumpUnread: (channelId, mention) =>
    set((s) => ({
      unread: { ...s.unread, [channelId]: (s.unread[channelId] ?? 0) + 1 },
      ...(mention && { mentioned: { ...s.mentioned, [channelId]: true as const } }),
    })),

  markRead: (channelId) => {
    const { unread, mentioned } = get();
    if (!unread[channelId] && !mentioned[channelId]) return;
    const nextMentioned = { ...mentioned };
    delete nextMentioned[channelId];
    set({ unread: { ...unread, [channelId]: 0 }, mentioned: nextMentioned });
  },

  recountUnread: (channelId, sk) => {
    const { me, unread, messagesByChannel } = get();
    const current = unread[channelId] ?? 0;
    if (!me || !current) return;
    // A read mark only ever lowers the count; what isn't loaded here stays counted.
    const after = countUnreadAfter(messagesByChannel[channelId] ?? [], sk, me.userId);
    if (after === 0) get().markRead(channelId);
    else if (after < current) set((s) => ({ unread: { ...s.unread, [channelId]: after } }));
  },

  invalidateInactive: () =>
    set((s) => {
      // What we have is still worth showing; it's just not guaranteed current.
      const stale: Record<string, true> = { ...s.stale };
      for (const id of Object.keys(s.messagesByChannel)) {
        if (id !== s.activeChannelId) stale[id] = true;
      }
      return { stale, historyRequests: {}, threads: {}, threadCursors: {}, threadRequests: {} };
    }),

  showToast: (toast) => set({ toast }),

  hydrate: (snapshot) =>
    set((s) => {
      if (!snapshot || !s.me) return { hydrated: true };
      const stale: Record<string, true> = { ...s.stale };
      const messagesByChannel = { ...s.messagesByChannel };
      const cursors = { ...s.cursors };
      for (const [channelId, cached] of Object.entries(snapshot.messagesByChannel)) {
        if (channelId in messagesByChannel) continue; // the server already spoke
        messagesByChannel[channelId] = cached;
        cursors[channelId] = snapshot.cursors[channelId] ?? null;
        stale[channelId] = true;
      }
      return {
        hydrated: true,
        channels: s.channelsLoaded ? s.channels : snapshot.channels,
        pinned: s.pinned.length ? s.pinned : snapshot.pinned,
        users: Object.keys(s.users).length > 1 ? s.users : { ...snapshot.users, ...s.users },
        directory: { ...snapshot.directory, ...s.directory },
        reads: { ...snapshot.reads, ...s.reads },
        messagesByChannel,
        cursors,
        stale,
      };
    }),

  threadRequested: (parentSk, kind) =>
    set((s) => ({ threadRequests: { ...s.threadRequests, [parentSk]: kind } })),

  receiveThreadHistory: (parentSk, items, nextCursor) =>
    set((s) => ({
      threads: { ...s.threads, [parentSk]: mergeMessages(s.threads[parentSk] ?? [], items) },
      threadCursors: { ...s.threadCursors, [parentSk]: nextCursor },
      threadRequests: { ...s.threadRequests, [parentSk]: undefined },
      directory: learnAuthors(s.directory, items),
    })),

  applyThreadUpdate: ({ channelId, sk, replyCount, lastReplyAt, replyUserIds }) =>
    set((s) =>
      patchMessage(s, channelId, sk, (m) => ({ ...m, replyCount, lastReplyAt, replyUserIds })),
    ),
}));

/** Unread count for a channel (messages from others after your read mark). */
export function selectUnread(state: ChatState, channelId: string): number {
  return state.unread[channelId] ?? 0;
}

/**
 * Name to show for a user: their display name, else the local part of their
 * email (from the directory or the message that mentions them).
 */
export function selectName(state: ChatState, userId: string, fallbackEmail?: string): string {
  return state.users[userId]?.displayName ?? displayName(fallbackEmail ?? state.directory[userId]);
}

/** Whether `userId` has a live connection right now. */
export function useIsOnline(userId: string | null | undefined): boolean {
  return useChat((s) => !!userId && !!s.online[userId]);
}

/** Stable resolver from userId (and optional email) to the name to show. */
export function useNameOf(): (userId: string, fallbackEmail?: string) => string {
  const users = useChat((s) => s.users);
  const directory = useChat((s) => s.directory);
  return useCallback(
    (userId, fallbackEmail) =>
      users[userId]?.displayName ?? displayName(fallbackEmail ?? directory[userId]),
    [users, directory],
  );
}
