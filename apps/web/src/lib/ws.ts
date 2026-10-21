import type { ClientActionInput, ServerEvent, ServerEventType } from "@mindfultech/shared";

export type WsStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type EventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
type Handler<T extends ServerEventType> = (event: EventOf<T>) => void;

/** `Omit` applied to each member of a union (plain `Omit` collapses it). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Fields of a client action, without the `action` route key. */
type PayloadOf<A extends ClientActionInput["action"]> = DistributiveOmit<
  Extract<ClientActionInput, { action: A }>,
  "action"
>;

const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff (1 s, 2 s, 4 s … 30 s) with "equal jitter". */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates the WebSocket endpoint before anything connects to it: only
 * `wss://`, or `ws://` to localhost for development, with no credentials,
 * query or fragment. Returns the normalized URL; throws otherwise.
 */
export function assertWebSocketUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid WebSocket URL: ${raw}`);
  }
  const secure = url.protocol === "wss:";
  const local = url.protocol === "ws:" && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) {
    throw new Error(`The WebSocket URL must use wss:// (ws:// only on localhost): ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`The WebSocket URL can't include credentials, a query or a fragment: ${raw}`);
  }
  return url.href;
}

export interface WsClientOptions {
  url: string;
  getToken: () => Promise<string>;
  /** Called when `getToken` fails with no way to recover (signed out). */
  onSessionExpired?: () => void;
  isSessionExpired?: (err: unknown) => boolean;
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
}

/** How long a probed socket may stay silent before it is considered dead. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Single WebSocket to API Gateway: queues frames while offline, reconnects with
 * backoff and lets callers subscribe to server events by `type`.
 */
export class WsClient {
  status: WsStatus = "idle";

  private socket: WebSocket | undefined;
  /** Frames waiting for the socket; a `key` (a message's clientId) keeps one frame per key. */
  private queue: Array<{ frame: string; key?: string }> = [];
  private readonly handlers = new Map<string, Set<(event: ServerEvent) => void>>();
  private readonly statusHandlers = new Set<(status: WsStatus) => void>();
  private readonly openHandlers = new Set<(info: { reconnected: boolean }) => void>();
  private attempt = 0;
  private hasConnected = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  /** When the current socket last delivered anything (a `pong` counts). */
  private lastFrameAt = 0;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly url: string;

  constructor(private readonly options: WsClientOptions) {
    this.url = assertWebSocketUrl(options.url);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.open();
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.probeTimer);
    this.queue = [];
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000);
    this.setStatus("closed");
  }

  /** Skips the remaining backoff (e.g. when the browser comes back online). */
  reconnectNow(): void {
    if (this.stopped || this.status !== "reconnecting" || this.socket) return;
    clearTimeout(this.timer);
    void this.open();
  }

  /**
   * Heartbeat with proof of life (Phase 25): sends `ping` asking for a `pong`
   * and, if the socket has delivered nothing at all within `timeoutMs`, treats
   * it as dead and reconnects. A socket can stay "open" after the laptop
   * sleeps or the network changes while nothing reaches it any more; without
   * this, new messages silently stopped until a reload. Not open: a pending
   * reconnect is started at once instead.
   */
  ping(payload: { active?: boolean } = {}, timeoutMs = PROBE_TIMEOUT_MS): void {
    const socket = this.socket;
    if (socket?.readyState !== 1) {
      this.reconnectNow();
      return;
    }
    const sentAt = Date.now();
    socket.send(JSON.stringify({ action: "ping", ...payload, probe: true }));
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      if (this.socket !== socket || this.lastFrameAt >= sentAt) return;
      this.dropDeadSocket(socket);
    }, timeoutMs);
  }

  /** The socket stopped delivering: forget it and reconnect now (a catch-up follows). */
  private dropDeadSocket(socket: WebSocket): void {
    this.socket = undefined;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already gone.
    }
    if (this.stopped) return;
    this.attempt = 0;
    clearTimeout(this.timer);
    void this.open();
  }

  /**
   * Sends now, or queues until the socket opens. With `key`, a queued frame of
   * the same key is replaced instead of joined: retrying a message while
   * offline must not send it twice on reconnect.
   */
  send<A extends ClientActionInput["action"]>(
    action: A,
    payload: PayloadOf<A>,
    key?: string,
  ): void {
    const frame = JSON.stringify({ action, ...payload });
    if (this.socket?.readyState === 1) {
      this.socket.send(frame);
      return;
    }
    if (key) this.queue = this.queue.filter((q) => q.key !== key);
    this.queue.push({ frame, key });
  }

  on<T extends ServerEventType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = handler as (event: ServerEvent) => void;
    set.add(h);
    return () => set.delete(h);
  }

  onStatus(handler: (status: WsStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Fires on every successful (re)connection. */
  onOpen(handler: (info: { reconnected: boolean }) => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  private async open(): Promise<void> {
    this.setStatus(this.hasConnected ? "reconnecting" : "connecting");

    let token: string;
    try {
      token = await this.options.getToken();
    } catch (err) {
      if (this.options.isSessionExpired?.(err)) {
        this.disconnect();
        this.options.onSessionExpired?.();
      } else {
        this.scheduleReconnect();
      }
      return;
    }
    if (this.stopped) return;

    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const url = new URL(this.url);
    url.searchParams.set("token", token);
    const socket = new Impl(url.href);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.attempt = 0;
      this.setStatus("open");
      const pending = this.queue;
      this.queue = [];
      pending.forEach(({ frame }) => socket.send(frame));
      this.openHandlers.forEach((h) => h({ reconnected }));
    };

    socket.onmessage = (message: MessageEvent) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      this.handlers.get(event.type)?.forEach((h) => h(event));
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.probeTimer);
      this.socket = undefined;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt++, this.options.random);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.open(), delay);
  }
}
