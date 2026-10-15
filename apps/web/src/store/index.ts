import type { Channel, Message, ReadMark, ReplySnapshot, UserProfile } from "@mindfultech/shared";
import { useCallback } from "react";
import { create } from "zustand";
import type { SessionUser } from "../lib/auth";
import { displayName } from "../lib/channels";
import { loadOwnProfile, saveOwnProfile } from "../lib/profile";
import type { DirectoryUser } from "../lib/config";
import type { WsStatus } from "../lib/ws";
import { countUnread, mergeMessages, pendingMessageId, type ChatMessage } from "./messages";

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
  /** Epoch ms of the last message read per channel (persisted per user). */
  lastReadTs: Record<string, number>;
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

  setSession: (me: SessionUser | null, team?: DirectoryUser[]) => void;
  setStatus: (status: WsStatus) => void;
  setChannels: (channels: Channel[]) => void;
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
  /** Starts (or, with `null`, ends) editing a message in `channelId`'s composer. */
  setEditing: (channelId: string, target: EditTarget | null) => void;
  setReadMark: (channelId: string, userId: string, mark: ReadMark) => void;
  /** `until`: when the indicator expires; `null` clears it. */
  setTyping: (channelId: string, userId: string, until: number | null) => void;
  setListAtBottom: (atBottom: boolean) => void;
  markRead: (channelId: string) => void;
  /** After a reconnect: forget cached history of inactive channels so it reloads on open. */
  invalidateInactive: () => void;
  showToast: (message: string | null) => void;
}

const lastReadKey = (userId: string) => `slack.lastReadTs.${userId}`;

function loadLastRead(userId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(lastReadKey(userId));
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveLastRead(userId: string, value: Record<string, number>): void {
  try {
    localStorage.setItem(lastReadKey(userId), JSON.stringify(value));
  } catch {
    // Storage full or blocked: unread badges just won't survive a reload.
  }
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
  lastReadTs: {},
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
};

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
      lastReadTs: me ? loadLastRead(me.userId) : {},
    });
  },

  setStatus: (status) => set({ status }),

  setChannels: (channels) =>
    set((s) => ({ channels, channelsLoaded: true, reads: readsOf(channels, s.reads) })),

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
      // A refresh of the newest page must not lose the cursor to older pages.
      const keepCursor = request === "initial" && channelId in s.cursors && existing.length > 0;
      return {
        messagesByChannel: { ...s.messagesByChannel, [channelId]: mergeMessages(existing, items) },
        cursors: keepCursor ? s.cursors : { ...s.cursors, [channelId]: nextCursor },
        historyRequests: { ...s.historyRequests, [channelId]: undefined },
        directory: learnAuthors(s.directory, items),
      };
    }),

  receiveMessage: (message, clientId) =>
    set((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [message.channelId]: mergeMessages(s.messagesByChannel[message.channelId] ?? [], [
          { ...message, clientId },
        ]),
      },
      directory: learnAuthors(s.directory, [message]),
    })),

  addPending: (message) =>
    set((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [message.channelId]: mergeMessages(s.messagesByChannel[message.channelId] ?? [], [message]),
      },
    })),

  setPendingStatus: (channelId, clientId, status) =>
    set((s) => {
      const messages = s.messagesByChannel[channelId];
      const id = pendingMessageId(clientId);
      if (!messages?.some((m) => m.messageId === id)) return {};
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: messages.map((m) => (m.messageId === id ? { ...m, status } : m)),
        },
      };
    }),

  setUsers: (list, onlineIds) =>
    set((s) => {
      const users: Record<string, UserProfile> = {};
      const directory = { ...s.directory };
      for (const u of list) {
        users[u.userId] = u;
        directory[u.userId] = u.email;
      }
      const mine = s.me && users[s.me.userId];
      if (mine) saveOwnProfile(mine);
      // A guest's directory may not list them yet: keep what we know about ourselves.
      else if (s.me && s.users[s.me.userId]) users[s.me.userId] = s.users[s.me.userId]!;
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
    set((s) => {
      const messages = s.messagesByChannel[channelId];
      if (!messages?.some((m) => m.sk === sk)) return {};
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: messages.map((m) => (m.sk === sk ? { ...m, reactions } : m)),
        },
      };
    }),

  applyEdit: (channelId, sk, text, editedAt) =>
    set((s) => {
      const messages = s.messagesByChannel[channelId];
      if (!messages?.some((m) => m.sk === sk)) return {};
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: messages.map((m) =>
            m.sk === sk ? { ...m, text, isEdited: true, editedAt } : m,
          ),
        },
      };
    }),

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

  markRead: (channelId) => {
    const { me, messagesByChannel, lastReadTs } = get();
    if (!me) return;
    // Server timestamps only, so a skewed client clock can't hide new messages.
    let latest = 0;
    for (const m of messagesByChannel[channelId] ?? []) {
      if (!m.status && m.createdAt > latest) latest = m.createdAt;
    }
    if ((lastReadTs[channelId] ?? 0) >= latest) return;
    const next = { ...lastReadTs, [channelId]: latest };
    saveLastRead(me.userId, next);
    set({ lastReadTs: next });
  },

  invalidateInactive: () =>
    set((s) => {
      const keep = s.activeChannelId;
      const pick = <T>(record: Record<string, T>) =>
        keep && keep in record ? { [keep]: record[keep] as T } : {};
      return {
        messagesByChannel: pick(s.messagesByChannel),
        cursors: pick(s.cursors),
        historyRequests: {},
      };
    }),

  showToast: (toast) => set({ toast }),
}));

/** Unread count for a channel (messages from others after the last read mark). */
export function selectUnread(state: ChatState, channelId: string): number {
  if (!state.me) return 0;
  return countUnread(
    state.messagesByChannel[channelId] ?? [],
    state.lastReadTs[channelId] ?? 0,
    state.me.userId,
  );
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
