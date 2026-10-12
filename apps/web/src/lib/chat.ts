import {
  dmChannelId,
  type Attachment,
  type ErrorCode,
  type PresignAction,
  type PresignResultEvent,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { useChat, type ChatMessage } from "../store";
import { pendingMessageId } from "../store/messages";
import { getIdToken, SessionExpiredError } from "./auth";
import { WsClient, type DistributiveOmit } from "./ws";

const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_REQUEST: "La solicitud no es válida.",
  UNAUTHORIZED: "Tu sesión expiró. Vuelve a iniciar sesión.",
  CHANNEL_NOT_FOUND: "Ese canal no existe o no tienes acceso.",
  CHANNEL_NAME_TAKEN: "Ya existe un canal con ese nombre.",
  FILE_NOT_FOUND: "El archivo ya no existe.",
  INTERNAL_ERROR: "Algo falló en el servidor. Inténtalo de nuevo.",
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
  private cleanups: Array<() => void> = [];
  private presigns = new Map<string, Deferred<PresignResultEvent>>();
  private pendingCreate: (Deferred<string> & { name: string }) | null = null;
  private sendTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
        if (message.channelId === s.activeChannelId && isFocused()) s.markRead(message.channelId);
      }),

      client.on("history.page", ({ channelId, items, nextCursor }) => {
        const s = store();
        s.receiveHistory(channelId, items, nextCursor);
        if (channelId === s.activeChannelId && isFocused()) s.markRead(channelId);
      }),

      client.on("channel.list", ({ channels }) => {
        store().setChannels(channels);
        const pending = this.pendingCreate;
        const created =
          pending && channels.find((c) => c.type === "public" && c.name === pending.name);
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
        const text = ERROR_TEXT[code] ?? message ?? "Error desconocido.";
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

    const onOnline = () => client.reconnectNow();
    window.addEventListener("online", onOnline);
    this.cleanups.push(() => window.removeEventListener("online", onOnline));

    client.connect();
  }

  stop(): void {
    this.client?.disconnect();
    this.client = null;
    // Requests in flight died with the socket; let the next session re-issue them.
    useChat.setState({ historyRequests: {} });
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.sendTimers.forEach((t) => clearTimeout(t));
    this.sendTimers.clear();
    for (const d of this.presigns.values()) {
      clearTimeout(d.timer);
      d.reject(new Error("Sesión cerrada"));
    }
    this.presigns.clear();
    if (this.pendingCreate) {
      clearTimeout(this.pendingCreate.timer);
      this.pendingCreate.reject(new Error("Sesión cerrada"));
      this.pendingCreate = null;
    }
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

  /** Creates a public channel; resolves with its id once the new list arrives. */
  createChannel(name: string): Promise<string> {
    const client = this.client;
    if (!client) return Promise.reject(new Error("Sin conexión"));
    if (this.pendingCreate) return Promise.reject(new Error("Ya se está creando un canal"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreate = null;
        reject(new Error("El servidor no respondió. Inténtalo de nuevo."));
      }, REQUEST_TIMEOUT_MS);
      this.pendingCreate = { name, resolve, reject, timer };
      client.send("channel", { op: "create", name });
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
    if (!client) return Promise.reject(new Error("Sin conexión"));
    const requestId = ulid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.presigns.delete(requestId);
        reject(new Error("El servidor no respondió. Inténtalo de nuevo."));
      }, REQUEST_TIMEOUT_MS);
      this.presigns.set(requestId, { resolve, reject, timer });
      client.send("presign", { ...request, requestId });
    });
  }
}

export const chat = new ChatController();
