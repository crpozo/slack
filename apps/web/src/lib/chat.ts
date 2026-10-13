import {
  compareIds,
  dmChannelId,
  type BoardEvent,
  type ChannelVisibility,
  type Attachment,
  type ErrorCode,
  type PresignAction,
  type PresignResultEvent,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { selectName, useChat, type ChatMessage } from "../store";
import { pendingMessageId } from "../store/messages";
import { getIdToken, SessionExpiredError } from "./auth";
import { calls } from "./call";
import { startHeartbeat } from "./heartbeat";
import { playMessageSound } from "./sounds";
import { useTasks } from "../store/tasks";
import { WsClient, type DistributiveOmit } from "./ws";

const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_REQUEST: "That request isn't valid.",
  UNAUTHORIZED: "Your session expired. Please sign in again.",
  CHANNEL_NOT_FOUND: "That channel doesn't exist or you don't have access.",
  CHANNEL_NAME_TAKEN: "A channel with that name already exists.",
  FILE_NOT_FOUND: "That file no longer exists.",
  FORBIDDEN: "You don't have permission to do that.",
  USER_NOT_FOUND: "That person doesn't exist or has never signed in.",
  MESSAGE_NOT_FOUND: "That message no longer exists.",
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

const isFocused = () => document.visibilityState === "visible" && document.hasFocus();

/** Glue between the WebSocket and the store; one instance per signed-in session. */
class ChatController {
  private client: WsClient | null = null;
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

    this.cleanups.push(
      client.onStatus((status) => store().setStatus(status)),

      client.onOpen(({ reconnected }) => {
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
        s.receiveMessage(message, clientId);
        if (!s.channels.some((c) => c.channelId === message.channelId)) {
          client.send("channel", { op: "list" }); // e.g. someone just opened a DM with us
        }
        const viewing = message.channelId === s.activeChannelId && isFocused();
        if (viewing) s.markRead(message.channelId);
        // A pop for messages from others that you are not already looking at.
        if (!viewing && message.userId !== s.me?.userId) playMessageSound();
      }),

      client.on("history.page", ({ channelId, items, nextCursor }) => {
        const s = store();
        s.receiveHistory(channelId, items, nextCursor);
        if (channelId === s.activeChannelId && isFocused()) s.markRead(channelId);
      }),

      client.on("user.list", ({ users, online }) => store().setUsers(users, online)),

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

      client.on("channel.list", ({ channels }) => {
        store().setChannels(channels);
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
      if (me) useTasks.getState().applyEvent(event, me.userId);
    };
    this.cleanups.push(
      client.on("board.task_created", applyBoardEvent),
      client.on("board.task_updated", applyBoardEvent),
      client.on("board.task_deleted", applyBoardEvent),
      client.on("board.updated", applyBoardEvent),
      // Keep the connection alive: API Gateway drops idle sockets after 10 minutes.
      startHeartbeat(client),
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
    if (kind === "older" && !cursor) return;
    s.historyRequested(channelId, kind);
    this.client.send("history", cursor ? { channelId, cursor } : { channelId });
  }

  /** Optimistically inserts the message, then sends it. */
  sendMessage(channelId: string, text: string, attachments: Attachment[]): void {
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
    };
    addPending(message);
    this.transmit(message);
  }

  retry(message: ChatMessage): void {
    if (!message.clientId) return;
    useChat.getState().setPendingStatus(message.channelId, message.clientId, "pending");
    this.transmit(message);
  }

  private transmit({ channelId, text, attachments, clientId }: ChatMessage): void {
    if (!this.client || !clientId) return;
    this.client.send("message", {
      channelId,
      text,
      attachments: attachments.length ? attachments : undefined,
      clientId,
    });
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
      client.send("channel", { op: "create", name, visibility });
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
