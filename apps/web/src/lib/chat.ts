import {
  compareIds,
  dmChannelId,
  isDmChannel,
  MAX_PINNED_CHATS,
  type BoardEvent,
  type CalendarPushEvent,
  type CallEvent,
  type ChannelVisibility,
  type ProjectBoard,
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
import { groupCalls } from "./groupCall";
import { isAppActive, watchActivity } from "./activity";
import { boardActivity, calendarActivity, raiseAlert } from "./alerts";
import { notificationBody, prepareDesktopNotifications, shouldNotify } from "./desktop";
import { startHeartbeat } from "./heartbeat";
import { messagesApi } from "./messagesApi";
import { notesApi } from "./notesApi";
import { playMessageSound } from "./sounds";
import { TasksApiError } from "./tasksApi";
import { useTasks } from "../store/tasks";
import { useCalendar } from "../store/calendar";
import { useNotesHub } from "../store/notesHub";
import { recordingExtension, type CallRecording } from "./callRecorder";
import { outbox, type UploadTask } from "./outbox";
import { WsClient, type DistributiveOmit } from "./ws";

const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_REQUEST: "That request isn't valid.",
  UNAUTHORIZED: "Your session expired. Please sign in again.",
  CHANNEL_NOT_FOUND: "That channel doesn't exist or you don't have access.",
  CHANNEL_NAME_TAKEN: "A channel with that name already exists.",
  FILE_NOT_FOUND: "That file no longer exists.",
  BOARD_NOT_FOUND: "That board doesn't exist or you can't see it.",
  CALL_FULL: "That call is full: it holds up to 6 people.",
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
  /** A sent message's timeout, and how its `transmit` settles (confirmed, or not). */
  private readonly sendTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; settle: (confirmed: boolean) => void }
  >();
  private readonly deletedListeners = new Set<(channelId: string, by: string) => void>();
  /** Phase 40: each ended call's notes request (whether its card was posted), by `callId`. */
  private readonly notesRequests = new Map<string, Promise<boolean>>();

  constructor() {
    // The outbox sends a message through here once its files are up.
    outbox.attach((message) => this.transmit(message));
  }

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
        // The channel calls going on (Phase 36); after a reconnect, `groupCalls` asks.
        if (!reconnected) client.send("call", { signal: "rooms" });
        if (reconnected) {
          // A call being restored after a network drop can restart ICE now.
          calls.signalingReconnected();
          groupCalls.signalingReconnected();
          // A read mark sent on the dead socket never arrived: send it again.
          this.readSent.clear();
          const viewing = store().activeChannelId;
          if (viewing) this.sendReadMark(viewing);
          // Catch up on whatever happened while we were offline.
          store().invalidateInactive();
          const active = store().activeChannelId;
          if (active) this.loadHistory(active, "initial");
        }
      }),

      client.on("message.new", ({ message, clientId }) => {
        this.settleSend(clientId, true);
        outbox.confirmed(clientId);
        const s = store();
        const known = s.messagesByChannel[message.channelId]?.some(
          (m) => m.messageId === message.messageId,
        );
        s.receiveMessage(message, clientId);
        useNotesHub.getState().upsert(message);
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
      client.on("message.updated", (event) => {
        const { channelId, sk, text, editedAt, meeting, aiNotes, deletedAt, replyTo } = event;
        if (deletedAt) {
          store().applyTombstone(channelId, sk, deletedAt);
          useNotesHub.getState().remove(channelId, sk);
        } else if (replyTo) store().applyQuote(channelId, sk, replyTo);
        else if (meeting) store().updateMeetingCard(channelId, sk, meeting, text);
        else if (aiNotes) {
          store().updateAiNotes(channelId, sk, aiNotes, text);
          useNotesHub.getState().update(channelId, sk, aiNotes, text);
        } else store().applyEdit(channelId, sk, text, editedAt ?? Date.now());
      }),
      // Deleted by its author or an admin (Phase 32): gone at once, everywhere.
      client.on("message.deleted", ({ channelId, sk }) => {
        if (this.activeThread === sk) store().showToast("This thread's message was deleted.");
        store().removeMessage(channelId, sk);
        useNotesHub.getState().remove(channelId, sk);
      }),
      client.on("channel.read", ({ channelId, userId, sk, at }) => {
        const s = store();
        s.setReadMark(channelId, userId, { sk, at });
        // You read it on another device: this one's badge follows, and the
        // bell too once nothing in it is unread any more.
        if (userId === s.me?.userId) {
          s.recountUnread(channelId, sk);
          if (!store().unread[channelId]) useNotifications.getState().markChannelRead(channelId);
        }
      }),
      client.on("user.typing", ({ channelId, userId }) => {
        const s = store();
        if (userId === s.me?.userId) return;
        s.setTyping(channelId, userId, Date.now() + TYPING_SHOW_MS);
      }),

      client.on("channel.updated", ({ channel }) => store().updateChannel(channel)),
      client.on("user.prefs", ({ pinned }) => store().setPinned(pinned)),
      client.on("message.pinned", (event) => store().applyPin(event)),

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
          store().showToast(text, "error");
        }
      }),
    );

    // WebRTC signaling: the call managers own everything about calls.
    const routeCall = (event: CallEvent) =>
      isDmChannel(event.channelId) ? calls.handle(event) : groupCalls.handle(event);
    groupCalls.attach({
      send: (payload, key) => client.send("call", payload, key),
      myUserId: () => store().me?.userId ?? null,
      nameOf: (userId) => selectName(store(), userId),
      notify: (text) => store().showToast(text),
      postMessage: (channelId, text) => this.sendMessage(channelId, text, []),
      dmCallActive: () => calls.busy,
      onStarted: ({ channelId, by }) => {
        const s = store();
        const channel = s.channels.find((c) => c.channelId === channelId);
        raiseAlert(
          {
            kind: "message",
            title: `${selectName(s, by)} started a call${channel ? ` in #${channel.name}` : ""}`,
            body: "Join it from the channel's header.",
            url: `/app/${encodeURIComponent(channelId)}`,
            channelId,
          },
          { sound: false }, // no ringing for channel calls
        );
      },
    });
    calls.attach({
      send: (payload, key) => client.send("call", payload, key),
      busyElsewhere: () => groupCalls.busy,
      postMessage: (channelId, text) => this.sendMessage(channelId, text, []),
      myUserId: () => store().me?.userId ?? null,
      nameOf: (userId) => selectName(store(), userId),
      notify: (text) => store().showToast(text),
      submitNotes: (input) => {
        // The ✨ card itself arrives over the socket (`message.new`, then `message.updated`).
        const requested = notesApi.summarizeCall(input);
        this.notesRequests.set(
          input.callId,
          requested.then(
            () => true,
            () => false,
          ),
        );
        requested.catch((err: unknown) => {
          const why = err instanceof TasksApiError ? ` ${err.message}` : "";
          store().showToast(`✨ The AI notes couldn't be requested.${why}`);
        });
      },
      submitRecording: (call, recording) => void this.attachRecording(call, recording),
    });
    this.cleanups.push(
      // DM calls ring (`calls`); channel calls are rooms (`groupCalls`, Phase 36).
      client.on("call.offer", routeCall),
      client.on("call.answer", routeCall),
      client.on("call.ice_candidate", routeCall),
      client.on("call.decline", routeCall),
      client.on("call.end", routeCall),
      client.on("call.renegotiate", routeCall),
      client.on("call.room", (event) => groupCalls.onRoom(event)),
      client.on("call.rooms", ({ rooms }) => groupCalls.setRooms(rooms)),
    );

    // Back online: a dead socket reconnects now, an "open" one must prove it's alive.
    const onOnline = () => client.ping({ active: isAppActive() });
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
      // Keep the connection alive (API Gateway drops idle sockets after 10 minutes)
      // and tell the server whether we're in front of the person: it pushes to
      // their devices only while none of them is active.
      startHeartbeat(client, isAppActive),
      watchActivity((active) => {
        // Back in front (woken laptop, unlocked phone, focused desktop app): the
        // socket may have died silently meanwhile. The probe reconnects (and
        // catches up) if it did; a reconnect in backoff starts at once.
        if (client.status !== "open") {
          if (active) client.reconnectNow();
          return;
        }
        client.ping({ active });
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
    groupCalls.detach();
    this.client?.disconnect();
    this.client = null;
    // Requests in flight died with the socket; let the next session re-issue them.
    useChat.setState({ historyRequests: {} });
    useNotifications.getState().load(null); // saved alerts stay for the next sign-in
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    for (const clientId of [...this.sendTimers.keys()]) this.settleSend(clientId, false);
    outbox.clear();
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

  /**
   * Shows the message at once (optimistic) and hands it to the outbox, which
   * sends it when its `files` are up, after the conversation's earlier
   * messages (as a reply when `replyTo` is set).
   */
  sendMessage(
    channelId: string,
    text: string,
    files: UploadTask[] = [],
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
      attachments: [],
      createdAt: Date.now(),
      clientId,
      status: "pending",
      ...(replyTo && { replyTo }),
      ...(isSecret && { isSecret: true as const }),
      ...(thread && { parentId: thread.messageId, parentSk: thread.sk }),
    };
    addPending(message);
    outbox.enqueue(message, files);
  }

  /**
   * Sends a failed message again, under the same `clientId`: only from the
   * `failed` state (a double tap, or a retry racing a late confirmation, does
   * nothing). The outbox uploads again whatever file failed and queues it
   * after the conversation's other messages; the server ignores a clientId it
   * already stored, so one message, however it raced.
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
    if (outbox.retry(clientId)) return;
    // Not the outbox's (sent before this page loaded it): straight out again.
    s.setPendingStatus(channelId, clientId, "pending");
    void this.transmit(current);
  }

  /**
   * Sends one message (its files already up). Resolves `true` when the server
   * confirms it (`message.new`), `false` when it doesn't in `SEND_TIMEOUT_MS`
   * (it turns "failed": Retry) or the session ends.
   */
  private transmit({
    channelId,
    text,
    attachments,
    clientId,
    replyTo,
    isSecret,
    parentId,
    parentSk,
  }: ChatMessage): Promise<boolean> {
    if (!this.client || !clientId) return Promise.resolve(false);
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
    this.settleSend(clientId, false);
    return new Promise<boolean>((settle) => {
      const timer = setTimeout(() => {
        this.sendTimers.delete(clientId);
        useChat.getState().setPendingStatus(channelId, clientId, "failed");
        settle(false);
      }, SEND_TIMEOUT_MS);
      this.sendTimers.set(clientId, { timer, settle });
    });
  }

  /** Ends a send's wait: confirmed by the server, or given up on. */
  private settleSend(clientId: string, confirmed: boolean): void {
    const pending = this.sendTimers.get(clientId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.sendTimers.delete(clientId);
    pending.settle(confirmed);
  }

  /**
   * Phase 40: once a call's notes card is posted and its recording is ready,
   * uploads the recording (like any attachment of the conversation) and
   * attaches it to the card. No card, no recording: it's dropped.
   */
  private async attachRecording(
    { callId, channelId }: { callId: string; channelId: string },
    recording: Promise<CallRecording | null>,
  ): Promise<void> {
    const [posted, clip] = await Promise.all([
      this.notesRequests.get(callId) ?? Promise.resolve(false),
      recording,
    ]);
    this.notesRequests.delete(callId);
    if (!posted || !clip) return;
    try {
      // Loaded on demand: `upload` itself uses this module.
      const { startUpload } = await import("./upload");
      const day = new Date().toISOString().slice(0, 10);
      const file = new File([clip.blob], `call-${day}.${recordingExtension(clip.mimeType)}`, {
        type: clip.mimeType,
      });
      const task = startUpload(file, channelId);
      const uploaded = await task.start();
      task.dispose();
      await notesApi.attachAudio(callId, {
        key: uploaded.key,
        contentType: clip.mimeType,
        size: uploaded.size,
        durationMs: Math.max(1, Math.round(clip.durationMs)),
      });
    } catch {
      useChat
        .getState()
        .showToast("✨ The call's recording couldn't be saved. The notes are fine.");
    }
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
   * Pins (or unpins) a conversation, channel or DM, to the sidebar's Pinned
   * section. Applied at once; the server's `user.prefs` (also sent to your
   * other devices) confirms it.
   */
  setPinned(channelId: string, pinned: boolean): void {
    const s = useChat.getState();
    const rest = s.pinned.filter((id) => id !== channelId);
    // The server would drop the oldest pin past the limit: say so instead.
    if (pinned && rest.length >= MAX_PINNED_CHATS) {
      s.showToast(`You can pin up to ${MAX_PINNED_CHATS} conversations. Unpin one first.`);
      return;
    }
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
    // Thread replies show on their parent's counter, not the channel's badge
    // (like Slack, and like the server's count since Phase 36).
    if (!known && !message.parentSk) {
      s.bumpUnread(message.channelId, notify && channel?.type === "public");
    }
    if (!channel || !notify) return;
    const sender = selectName(s, message.userId, message.userEmail);
    const dm = channel.type === "dm";
    raiseAlert(
      {
        kind: dm || channel.type === "private" ? "message" : "mention",
        title: dm || !("name" in channel) ? sender : `${sender} in #${channel.name}`,
        body: notificationBody(message),
        url: `/app/${encodeURIComponent(message.channelId)}`,
        channelId: message.channelId,
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
    // The bell follows the badge: this conversation's alerts are read too.
    useNotifications.getState().markChannelRead(channelId);
    this.sendReadMark(channelId);
  }

  /**
   * The newest `sk` sent as a read mark per channel (don't repeat it while the
   * echo is in flight). Cleared when the socket reconnects: a mark sent on a
   * socket that had silently died never reached the server, and keeping it
   * here would stop it from ever being sent again (Phase 36).
   */
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

  /**
   * Deletes a message (yours, or anyone's as an admin; Phase 32). It goes
   * from the screen at once (a parent with replies becomes "This message was
   * deleted"); if the server refuses, it comes back with the reason.
   */
  async deleteMessage(message: ChatMessage): Promise<void> {
    const store = () => useChat.getState();
    const s = store();
    const keepsThread = !message.parentSk && (message.replyCount ?? 0) > 0;
    if (keepsThread) s.applyTombstone(message.channelId, message.sk, Date.now());
    else s.removeMessage(message.channelId, message.sk);
    try {
      await messagesApi.delete(message.channelId, message.sk);
    } catch (err) {
      if (err instanceof TasksApiError && err.status === 404) return; // already gone
      store().restoreMessage(message);
      store().showToast(
        err instanceof TasksApiError ? err.message : "Couldn't delete the message. Try again.",
      );
    }
  }

  /**
   * Pins a message to its channel or unpins it (Phase 38). Everyone in it,
   * you included, hears `message.pinned`; refusals arrive as toasts.
   */
  pinMessage(message: { channelId: string; sk: string }, pinned: boolean): void {
    this.client?.send("pin", { channelId: message.channelId, sk: message.sk, pinned });
  }

  /**
   * "Jump to message" (Phase 38): the conversation's list scrolls to it,
   * loading older pages until it's there (see MessageList). A thread reply
   * jumps to its parent and opens the thread. The caller navigates.
   */
  jumpTo(target: { channelId: string; sk: string; parentSk?: string }): void {
    useChat
      .getState()
      .setJumpTarget(
        target.parentSk
          ? { channelId: target.channelId, sk: target.parentSk, openThread: true }
          : { channelId: target.channelId, sk: target.sk },
      );
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
