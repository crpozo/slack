import type { Channel, Message } from "@mindfultech/shared";
import { create } from "zustand";
import type { SessionUser } from "../lib/auth";
import type { DirectoryUser } from "../lib/config";
import type { WsStatus } from "../lib/ws";
import { countUnread, mergeMessages, pendingMessageId, type ChatMessage } from "./messages";

export type { ChatMessage } from "./messages";

type HistoryRequest = "initial" | "older";

export interface ChatState {
  me: SessionUser | null;
  status: WsStatus;
  channels: Channel[];
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
  /** Users from VITE_USERS, for the DM list. */
  team: DirectoryUser[];
  toast: string | null;

  setSession: (me: SessionUser | null, team?: DirectoryUser[]) => void;
  setStatus: (status: WsStatus) => void;
  setChannels: (channels: Channel[]) => void;
  setActiveChannel: (channelId: string | null) => void;
  historyRequested: (channelId: string, kind: HistoryRequest) => void;
  receiveHistory: (channelId: string, items: Message[], nextCursor: string | null) => void;
  receiveMessage: (message: Message, clientId?: string) => void;
  addPending: (message: ChatMessage) => void;
  setPendingStatus: (channelId: string, clientId: string, status: "pending" | "failed") => void;
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
  channelsLoaded: false,
  activeChannelId: null,
  messagesByChannel: {},
  cursors: {},
  historyRequests: {},
  lastReadTs: {},
  directory: {},
  team: [],
  toast: null,
};

export const useChat = create<ChatState>()((set, get) => ({
  ...initialState,

  setSession: (me, team = []) => {
    const directory: Record<string, string> = {};
    for (const u of team) if (u.userId) directory[u.userId] = u.email;
    if (me) directory[me.userId] = me.email;
    set({ ...initialState, me, team, directory, lastReadTs: me ? loadLastRead(me.userId) : {} });
  },

  setStatus: (status) => set({ status }),

  setChannels: (channels) => set({ channels, channelsLoaded: true }),

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
