import {
  compareIds,
  dmChannelId,
  isDmChannel,
  type BoardEvent,
  type CalendarPushEvent,
  type ChannelVisibility,
  type ProjectBoard,
  type Attachment,
  type ErrorCode,
  type Message,
  type PresignAction,
  type PresignResultEvent,
  type ReplySnapshot,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { selectName, useChat, type ChatMessage } from "../store";
import { pendingMessageId } from "../store/messages";
import { useNotifications } from "../store/notifications";
import { getIdToken, SessionExpiredError } from "./auth";
import { calls } from "./call";
import { isAppActive, watchActivity } from "./activity";
import { boardActivity, calendarActivity, raiseAlert } from "./alerts";
import { notificationBody, prepareDesktopNotifications, shouldNotify } from "./desktop";
import { startHeartbeat } from "./heartbeat";
import { playMessageSound } from "./sounds";
import { useTasks } from "../store/tasks";
import { useCalendar } from "../store/calendar";
import { useCanvas } from "../store/canvas";
import { WsClient, type DistributiveOmit } from "./ws";

const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_REQUEST: "That request isn't valid.",
  UNAUTHORIZED: "Your session expired. Please sign in again.",
  CHANNEL_NOT_FOUND: "That channel doesn't exist or you don't have access.",
  CHANNEL_NAME_TAKEN: "A channel with that name already exists.",
  FILE_NOT_FOUND: "That file no longer exists.",
  BOARD_NOT_FOUND: "That board doesn't exist or you can't see it.",
  FORBIDDEN: "You don't have permission to do that.",
  USER_NOT_FOUND: "That person doesn't exist or has never signed in.",
  MESSAGE_NOT_FOUND: "That message no longer exists.",
  RATE_LIMITED: "Slow down a little and try again in a moment.",
  INTERNAL_ERROR: "Something went wrong on the server. Please try again.",
};

const SEND_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type PresignRequest = DistributiveOmit<PresignAction, "action" | "requestId">;

/** In front of the person (in the desktop app, per Tauri: see `activity.ts`). */
const isFocused = isAppActive;
/** The directory is re-read when the app comes back to the front after this long. */
const DIRECTORY_REFRESH_MS = 10 * 60_000;
/** Keystrokes send `typing` at most this often… */
export const TYPING_INTERVAL_MS = 3000;
/** …and the indicator stays this long after the last one (slightly more than the interval). */
export const TYPING_SHOW_MS = 5000;

/** Fields of a channel its creator or an admin can edit. */
export interface ChannelEdit {
  /** Admins: archive (read-only, out of the sidebar) or restore. */
  archived?: boolean;
  name?: string;
  topic?: string;
  description?: string;
  /** `false` unlinks the board; `true` needs `board` unless the channel already has one. */
  isProject?: boolean;
  board?: ProjectBoard;
}

/** Glue between the WebSocket and the store; one instance per signed-in session. */
class ChatController {
  private client: WsClient | null = null;
  private usersFetchedAt = 0;
  private readonly cleanups: Array<() => void> = [];
  private readonly presigns = new Map<string, Deferred<PresignResultEvent>>();
  private pendingCreate: (Deferred<string> & { name: string }) | null = null;
  private pendingName: (Deferred<void> & { name: string }) | null = null;
  private readonly sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deletedListeners = new Set<(channelId: string, by: string) => void>();

  /**
   * Called when a channel or DM you can see is deleted (by anyone, you included),
   * before it leaves the store, so the UI can navigate away first.
   */
  onChannelDeleted(listener: (channelId: string, by: string) => void): () => void {
    this.deletedListeners.add(listener);
    return () => this.deletedListeners.delete(listener);
  }

  start(wsUrl: string, onSessionExpired: () => void): void {
    if (this.client) return;
    const client = new WsClient({
      url: wsUrl,
      getToken: getIdToken,
      isSessionExpired: (err) => err instanceof SessionExpiredError,
      onSessionExpired,
    });
    this.client = client;
    const store = useChat.getState;
    prepareDesktopNotifications();
    useNotifications.getState().load(store().me?.userId ?? null);

    this.cleanups.push(
      client.onStatus((status) => store().setStatus(status)),

      client.onOpen(({ reconnected }) => {
        // Guests only have boards: the server refuses every chat request of theirs.
        if (store().me?.role === "guest") {
          client.send("user", { op: "list" });
          return;
        }
        client.send("channel", { op: "list" });
        client.send("user", { op: "list" });
        if (reconnected) {
          // Catch up on whatever happened while we were offline.
          store().invalidateInactive();
          const active = store().activeChannelId;
          if (active) this.loadHistory(active, "initial");
        }
      }),

      client.on("message.new", ({ message, clientId }) => {
        clearTimeout(this.sendTimers.get(clientId));
        this.sendTimers.delete(clientId);
        const s = store();
        const known = s.messagesByChannel[message.channelId]?.some(
          (m) => m.messageId === message.messageId,
        );
        s.receiveMessage(message, clientId);
        if (!s.channels.some((c) => c.channelId === message.channelId)) {
          client.send("channel", { op: "list" }); // e.g. someone just opened a DM with us
        }
        const parentSk = message.parentSk ?? null;
        const viewing =
          message.channelId === s.activeChannelId &&
          isFocused() &&
          (parentSk === null || parentSk === this.activeThread);
        if (viewing) this.viewed(message.channelId);
        // Their message arrived: whatever they were typing is sent.
        s.setTyping(message.channelId, message.userId, null);
        this.incoming(message, viewing, known);
      }),

      client.on("history.page", ({ channelId, thread, items, nextCursor }) => {
        const s = store();
        if (thread) return s.receiveThreadHistory(thread.sk, items, nextCursor);
        s.receiveHistory(channelId, items, nextCursor);
        if (channelId === s.activeChannelId && isFocused()) this.viewed(channelId);
      }),
      client.on("message.thread_updated", (event) => store().applyThreadUpdate(event)),

      client.on("user.list", ({ users, online }) => {
        this.usersFetchedAt = Date.now();
        store().setUsers(users, online);
      }),

      // Presence (Phase 7).
      client.on("user.connected", ({ userId }) => store().setPresence(userId, true)),
      client.on("user.disconnected", ({ userId }) => store().setPresence(userId, false)),

      client.on("channel.deleted", ({ channelId, by }) => {
        // Listeners first (they move off the channel), then forget it.
        this.deletedListeners.forEach((fn) => fn(channelId, by));
        store().removeChannel(channelId);
      }),

      client.on("user.updated", ({ user }) => {
        store().upsertUser(user);
        const pending = this.pendingName;
        if (pending && user.userId === store().me?.userId && user.displayName === pending.name) {
          clearTimeout(pending.timer);
          this.pendingName = null;
          pending.resolve();
        }
      }),

      client.on("message.reaction", ({ channelId, sk, reactions }) =>
        store().setReactions(channelId, sk, reactions),
      ),
      client.on("message.updated", ({ channelId, sk, text, editedAt, meeting }) =>
        meeting
          ? store().updateMeetingCard(channelId, sk, meeting, text)
          : store().applyEdit(channelId, sk, text, editedAt ?? Date.now()),
      ),
      client.on("channel.read", ({ channelId, userId, sk, at }) => {
        const s = store();
        s.setReadMark(channelId, userId, { sk, at });
        // You read it on another device: this one's badge follows.
        if (userId === s.me?.userId) s.recountUnread(channelId, sk);
      }),
      client.on("user.typing", ({ channelId, userId }) => {
        const s = store();
        if (userId === s.me?.userId) return;
        s.setTyping(channelId, userId, Date.now() + TYPING_SHOW_MS);
      }),

      client.on("channel.updated", ({ channel }) => store().updateChannel(channel)),
      client.on("user.prefs", ({ pinned }) => store().setPinned(pinned)),

      client.on("channel.list", ({ channels, unread }) => {
        const s = store();
        s.setChannels(channels, unread);
        // The server counted from your read mark; what's on screen is read.
        if (s.activeChannelId && isFocused()) s.markRead(s.activeChannelId);
        const pending = this.pendingCreate;
        const created = pending && channels.find((c) => c.type !== "dm" && c.name === pending.name);
        if (pending && created) {
          clearTimeout(pending.timer);
          this.pendingCreate = null;
          pending.resolve(created.channelId);
        }
      }),

      client.on("presign.result", (event) => {
        const deferred = this.presigns.get(event.requestId);
        if (!deferred) return;
        clearTimeout(deferred.timer);
        this.presigns.delete(event.requestId);
        deferred.resolve(event);
      }),

      client.on("error", ({ code, message, requestId }) => {
        const text = ERROR_TEXT[code] ?? message ?? "Unknown error.";
        const presign = requestId ? this.presigns.get(requestId) : undefined;
        if (requestId && presign) {
          clearTimeout(presign.timer);
          this.presigns.delete(requestId);
          presign.reject(new Error(text));
        } else if (code === "CHANNEL_NAME_TAKEN" && this.pendingCreate) {
          clearTimeout(this.pendingCreate.timer);
          this.pendingCreate.reject(new Error(text));
          this.pendingCreate = null;
        } else if (code === "UNAUTHORIZED") {
          onSessionExpired();
        } else {
          store().showToast(text);
        }
      }),
    );

    // WebRTC signaling: the call manager owns everything about calls.
    calls.attach({
      send: (payload) => client.send("call", payload),
      postMessage: (channelId, text) => this.sendMessage(channelId, text, []),
      myUserId: () => store().me?.userId ?? null,
      nameOf: (userId) => selectName(store(), userId),
      notify: (text) => store().showToast(text),
    });
    this.cleanups.push(
      client.on("call.offer", (event) => calls.handle(event)),
      client.on("call.answer", (event) => calls.handle(event)),
      client.on("call.ice_candidate", (event) => calls.handle(event)),
      client.on("call.decline", (event) => calls.handle(event)),
      client.on("call.end", (event) => calls.handle(event)),
    );

    const onOnline = () => client.reconnectNow();
    window.addEventListener("online", onOnline);

    // Task Manager pushes (sent by the HTTP API's Lambda through this socket).
    const applyBoardEvent = (event: BoardEvent) => {
      const me = store().me;
      if (!me) return;
      useTasks.getState().applyEvent(event, me.userId);
      const activity = boardActivity(event, me.userId);
      if (activity) raiseAlert(activity);
    };
    // Company calendar pushes, the same way.
    const applyCalendarEvent = (event: CalendarPushEvent) => {
      const me = store().me;
      if (!me) return;
      useCalendar.getState().applyEvent(event, me);
      const activity = calendarActivity(event, me.userId);
      if (activity) raiseAlert(activity);
    };
    this.cleanups.push(
      client.on("board.task_created", applyBoardEvent),
      client.on("board.task_updated", applyBoardEvent),
      client.on("board.task_deleted", applyBoardEvent),
      client.on("board.updated", applyBoardEvent),
      client.on("board.deleted", applyBoardEvent),
      client.on("calendar.event_created", applyCalendarEvent),
      client.on("calendar.event_updated", applyCalendarEvent),
      client.on("calendar.event_deleted", applyCalendarEvent),
      // The channel canvas: someone else's save is refetched if we show that canvas.
      client.on("canvas.updated", (event) => {
        const me = store().me;
        if (me) useCanvas.getState().applyEvent(event, me.userId);
      }),
      // Keep the connection alive (API Gateway drops idle sockets after 10 minutes)
      // and tell the server whether we're in front of the person: it pushes to
      // their devices only while none of them is active.
      startHeartbeat(client, isAppActive),
      watchActivity((active) => {
        if (client.status !== "open") return;
        client.send("ping", { active });
        // Back in front after a while (the desktop app runs for days): refresh
        // names, so a display name changed elsewhere shows here too.
        if (active && Date.now() - this.usersFetchedAt > DIRECTORY_REFRESH_MS) {
          this.usersFetchedAt = Date.now();
          client.send("user", { op: "list" });
        }
      }),
      () => window.removeEventListener("online", onOnline),
    );

    client.connect();
  }

  stop(): void {
    // Hang up while the socket can still tell the other side.
    calls.detach();
    this.client?.disconnect();
    this.client = null;
    // Requests in flight died with the socket; let the next session re-issue them.
    useChat.setState({ historyRequests: {} });
    useNotifications.getState().load(null); // saved alerts stay for the next sign-in
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.sendTimers.forEach((t) => clearTimeout(t));
    this.sendTimers.clear();
    for (const d of this.presigns.values()) {
      clearTimeout(d.timer);
      d.reject(new Error("Signed out"));
    }
    this.presigns.clear();
    for (const pending of [this.pendingCreate, this.pendingName]) {
      if (!pending) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Signed out"));
    }
    this.pendingCreate = null;
    this.pendingName = null;
  }

  /** Requests the newest page (`initial`) or the next older one (`older`). */
  loadHistory(channelId: string, kind: "initial" | "older"): void {
    const s = useChat.getState();
    if (!this.client || s.historyRequests[channelId]) return;
    const cursor = kind === "older" ? s.cursors[channelId] : undefined;
    // "stale" is the offline cache saying "there's more"; the next page's cursor
    // only arrives with a fresh first page, which `initial` fetches.
    if (kind === "older" && (!cursor || cursor === "stale")) return;
    s.historyRequested(channelId, kind);
    this.client.send("history", cursor ? { channelId, cursor } : { channelId });
  }

  /** The thread the user is looking at (its replies count as seen on arrival). */
  private activeThread: string | null = null;

  setActiveThread(parentSk: string | null): void {
    this.activeThread = parentSk;
  }

  /** A page of a thread's replies: the first one, or older ones from its cursor. */
  loadThread(
    channelId: string,
    parent: { messageId: string; sk: string },
    kind: "initial" | "older",
  ): void {
    const s = useChat.getState();
    if (!this.client || s.threadRequests[parent.sk]) return;
    const cursor = kind === "older" ? s.threadCursors[parent.sk] : undefined;
    if (kind === "older" && !cursor) return;
    s.threadRequested(parent.sk, kind);
    this.client.send("history", {
      channelId,
      thread: { messageId: parent.messageId, sk: parent.sk },
      ...(cursor && { cursor }),
    });
  }

  /** Optimistically inserts the message, then sends it (as a reply when `replyTo` is set). */
  sendMessage(
    channelId: string,
    text: string,
    attachments: Attachment[],
    replyTo?: ReplySnapshot,
    /** A password or API key: masked for readers, deleted by the server after a week. */
    isSecret = false,
    /** A reply in this top-level message's thread. */
    thread?: { messageId: string; sk: string },
  ): void {
    const { me, addPending } = useChat.getState();
    if (!me) return;
    const clientId = ulid();
    const message: ChatMessage = {
      messageId: pendingMessageId(clientId),
      channelId,
      sk: "",
      userId: me.userId,
      userEmail: me.email,
      text,
      attachments,
      createdAt: Date.now(),
      clientId,
      status: "pending",
      ...(replyTo && { replyTo }),
      ...(isSecret && { isSecret: true as const }),
      ...(thread && { parentId: thread.messageId, parentSk: thread.sk }),
    };
    addPending(message);
    this.transmit(message);
  }

  /**
   * Sends a failed message again, under the same `clientId`: only from the
   * `failed` state (a double tap, or a retry racing a late confirmation, does
   * nothing), it replaces any copy still queued while offline, and the server
   * ignores a clientId it already stored — so one message, however it raced.
   */
  retry(message: ChatMessage): void {
    const { clientId, channelId } = message;
    if (!clientId) return;
    const s = useChat.getState();
    const id = pendingMessageId(clientId);
    const current =
      s.messagesByChannel[channelId]?.find((m) => m.messageId === id) ??
      (message.parentSk ? s.threads[message.parentSk]?.find((m) => m.messageId === id) : undefined);
    if (current?.status !== "failed") return;
    useChat.getState().setPendingStatus(channelId, clientId, "pending");
    this.transmit(current);
  }

  private transmit({
    channelId,
    text,
    attachments,
    clientId,
    replyTo,
    isSecret,
    parentId,
    parentSk,
  }: ChatMessage): void {
    if (!this.client || !clientId) return;
    this.client.send(
      "message",
      {
        channelId,
        text,
        attachments: attachments.length ? attachments : undefined,
        clientId,
        ...(replyTo && { replyTo: { messageId: replyTo.messageId, sk: replyTo.sk } }),
        ...(isSecret && { isSecret }),
        ...(parentId && parentSk && { thread: { messageId: parentId, sk: parentSk } }),
      },
      clientId,
    );
    clearTimeout(this.sendTimers.get(clientId));
    this.sendTimers.set(
      clientId,
      setTimeout(() => {
        this.sendTimers.delete(clientId);
        useChat.getState().setPendingStatus(channelId, clientId, "failed");
      }, SEND_TIMEOUT_MS),
    );
  }

  /**
   * Creates a channel (private by default) and invites `invitees` to it;
   * resolves with the new channel id once the updated list arrives.
   */
  async createChannel(
    rawName: string,
    visibility: ChannelVisibility = "private",
    invitees: string[] = [],
    /** Makes it a project channel: link this board, or create one named after the channel. */
    board?: ProjectBoard,
  ): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("Not connected");
    if (this.pendingCreate) throw new Error("A channel is already being created");
    const name = rawName.trim(); // stored trimmed; `channel.list` is matched on it
    const channelId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreate = null;
        reject(new Error("The server didn't respond. Please try again."));
      }, REQUEST_TIMEOUT_MS);
      this.pendingCreate = { name, resolve, reject, timer };
      client.send("channel", {
        op: "create",
        name,
        visibility,
        ...(board && { isProject: true, board }),
      });
    });
    if (visibility === "private" && invitees.length > 0) this.invite(channelId, invitees);
    return channelId;
  }

  /**
   * Deletes a channel you created, or a DM you're in, with all its messages.
   * Everyone who could see it gets `channel.deleted`; errors arrive as toasts.
   */
  deleteChannel(channelId: string): void {
    this.client?.send("channel", { op: "delete", channelId });
  }

  /** Renames a channel (its creator or an admin); everyone sees `channel.updated`. */
  /** Name, topic and/or description; everyone in the channel gets `channel.updated`. */
  updateChannel(channelId: string, fields: ChannelEdit): void {
    const trimmed = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
    ) as ChannelEdit;
    this.client?.send("channel", { op: "update", channelId, ...trimmed });
  }

  /**
   * Pins (or unpins) a conversation to the top of your DM list. Applied at once;
   * the server's `user.prefs` (also sent to your other devices) confirms it.
   */
  setPinned(channelId: string, pinned: boolean): void {
    const s = useChat.getState();
    const rest = s.pinned.filter((id) => id !== channelId);
    s.setPinned(pinned ? [channelId, ...rest] : rest);
    this.client?.send("user", { op: "pin", channelId, pinned });
  }

  /**
   * A message arrived where you aren't looking: the pop, the unread count
   * (unless `known`: already in the list), and for DMs, private channels and
   * @mentions the bell (and the desktop app's notification while it's in the
   * background). Your own messages mark the conversation read instead.
   */
  private incoming(message: Message, viewing: boolean, known: boolean | undefined): void {
    const s = useChat.getState();
    const mine = message.userId === s.me?.userId;
    if (mine) {
      s.markRead(message.channelId); // you wrote: you read
      return;
    }
    if (viewing) return;
    playMessageSound();
    // A brand-new DM isn't in the channel list yet; its id says what it is.
    const channel =
      s.channels.find((c) => c.channelId === message.channelId) ??
      (isDmChannel(message.channelId) ? ({ type: "dm" } as const) : undefined);
    const me = s.me && { ...s.me, displayName: s.users[s.me.userId]?.displayName };
    const notify = !!channel && !!me && shouldNotify(channel, message, me);
    if (!known) s.bumpUnread(message.channelId, notify && channel?.type === "public");
    if (!channel || !notify) return;
    const sender = selectName(s, message.userId, message.userEmail);
    const dm = channel.type === "dm";
    raiseAlert(
      {
        kind: dm || channel.type === "private" ? "message" : "mention",
        title: dm || !("name" in channel) ? sender : `${sender} in #${channel.name}`,
        body: notificationBody(message),
        url: `/app/${encodeURIComponent(message.channelId)}`,
      },
      { sound: false }, // the pop above already played
    );
  }

  /**
   * The user is looking at `channelId`: marks it read locally and, when the
   * list is scrolled to the bottom, tells the channel how far they've read.
   */
  viewed(channelId: string): void {
    const s = useChat.getState();
    s.markRead(channelId);
    this.sendReadMark(channelId);
  }

  /** The newest `sk` sent as a read mark per channel (don't repeat it while the echo is in flight). */
  private readSent = new Map<string, string>();

  /**
   * Sends `read` for the newest message someone else wrote, at most once per
   * message: only while focused and scrolled to the bottom, and only if it is
   * past your current watermark. One write per "caught up", not per message.
   * (Your own messages need no mark, but replying must not leave theirs unread.)
   */
  sendReadMark(channelId: string): void {
    const s = useChat.getState();
    if (!this.client || !s.me || !isFocused() || !s.listAtBottom) return;
    if (channelId !== s.activeChannelId) return;
    const me = s.me.userId;
    const latest = [...(s.messagesByChannel[channelId] ?? [])]
      .reverse()
      .find((m) => !m.status && m.userId !== me);
    if (!latest) return;
    const mine = s.reads[channelId]?.[me];
    if (mine && mine.sk >= latest.sk) return;
    if (this.readSent.get(channelId) === latest.sk) return;
    this.readSent.set(channelId, latest.sk);
    this.client.send("read", { channelId, sk: latest.sk });
  }

  private typingSentAt = new Map<string, number>();

  /** Re-reads the directory (e.g. after inviting someone new to a board). */
  refreshUsers(): void {
    this.client?.send("user", { op: "list" });
  }

  /** Called on every keystroke; actually sends `typing` at most every `TYPING_INTERVAL_MS`. */
  typing(channelId: string): void {
    const now = Date.now();
    if (now - (this.typingSentAt.get(channelId) ?? 0) < TYPING_INTERVAL_MS) return;
    this.typingSentAt.set(channelId, now);
    this.client?.send("typing", { channelId });
  }

  /** Replaces the text of one of your messages; the server answers with `message.updated`. */
  editMessage(channelId: string, sk: string, text: string): void {
    this.client?.send("edit", { channelId, sk, text });
  }

  /** Adds people to a private channel you created; errors arrive as toasts. */
  invite(channelId: string, userIds: string[]): void {
    if (userIds.length === 0) return;
    this.client?.send("channel", { op: "invite", channelId, userIds });
  }

  /** Sets your display name; resolves when the server confirms it. */
  updateDisplayName(displayName: string): Promise<void> {
    const client = this.client;
    if (!client) return Promise.reject(new Error("Not connected"));
    const name = displayName.trim();
    this.pendingName?.reject(new Error("Replaced by a newer change"));
    if (this.pendingName) clearTimeout(this.pendingName.timer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingName = null;
        reject(new Error("The server didn't respond. Please try again."));
      }, REQUEST_TIMEOUT_MS);
      this.pendingName = { name, resolve, reject, timer };
      client.send("user", { op: "update", displayName: name });
    });
  }

  /** Adds or removes your `emoji` reaction, updating the UI right away. */
  toggleReaction(message: ChatMessage, emoji: string): void {
    const s = useChat.getState();
    const me = s.me;
    if (!me || !this.client || message.status) return;
    const current = message.reactions ?? {};
    const mine = current[emoji]?.includes(me.userId) ?? false;
    const users = mine
      ? (current[emoji] ?? []).filter((id) => id !== me.userId)
      : [...(current[emoji] ?? []), me.userId].sort(compareIds);
    const next = { ...current };
    if (users.length > 0) next[emoji] = users;
    else delete next[emoji];
    // Optimistic; the server's `message.reaction` broadcast is the source of truth.
    s.setReactions(message.channelId, message.sk, next);
    this.client.send("react", {
      channelId: message.channelId,
      sk: message.sk,
      emoji,
      op: mine ? "remove" : "add",
    });
  }

  /** Opens (or creates) the DM with `userId` and returns its channel id right away. */
  openDm(userId: string): string | null {
    const me = useChat.getState().me;
    if (!me || !this.client) return null;
    this.client.send("channel", { op: "dm", withUserId: userId });
    return dmChannelId(me.userId, userId);
  }

  presign(request: PresignRequest): Promise<PresignResultEvent> {
    const client = this.client;
    if (!client) return Promise.reject(new Error("Not connected"));
    const requestId = ulid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.presigns.delete(requestId);
        reject(new Error("The server didn't respond. Please try again."));
      }, REQUEST_TIMEOUT_MS);
      this.presigns.set(requestId, { resolve, reject, timer });
      client.send("presign", { ...request, requestId });
    });
  }
}

export const chat = new ChatController();
