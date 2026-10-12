import type { ClientAction, ServerEvent, ServerEventType } from "@mindfultech/shared";

export type WsStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type EventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
type Handler<T extends ServerEventType> = (event: EventOf<T>) => void;

/** `Omit` applied to each member of a union (plain `Omit` collapses it). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Fields of a client action, without the `action` route key. */
type PayloadOf<A extends ClientAction["action"]> = DistributiveOmit<
  Extract<ClientAction, { action: A }>,
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
    throw new Error(`URL de WebSocket inválida: ${raw}`);
  }
  const secure = url.protocol === "wss:";
  const local = url.protocol === "ws:" && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) {
    throw new Error(`La URL del WebSocket debe usar wss:// (ws:// solo en localhost): ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `La URL del WebSocket no puede llevar credenciales, query ni fragmento: ${raw}`,
    );
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

/**
 * Single WebSocket to API Gateway: queues frames while offline, reconnects with
 * backoff and lets callers subscribe to server events by `type`.
 */
export class WsClient {
  status: WsStatus = "idle";

  private socket: WebSocket | undefined;
  private queue: string[] = [];
  private handlers = new Map<string, Set<(event: ServerEvent) => void>>();
  private statusHandlers = new Set<(status: WsStatus) => void>();
  private openHandlers = new Set<(info: { reconnected: boolean }) => void>();
  private attempt = 0;
  private hasConnected = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

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

  send<A extends ClientAction["action"]>(action: A, payload: PayloadOf<A>): void {
    const frame = JSON.stringify({ action, ...payload });
    if (this.socket?.readyState === 1) this.socket.send(frame);
    else this.queue.push(frame);
  }

  on<T extends ServerEventType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
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
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.attempt = 0;
      this.setStatus("open");
      const pending = this.queue;
      this.queue = [];
      pending.forEach((frame) => socket.send(frame));
      this.openHandlers.forEach((h) => h({ reconnected }));
    };

    socket.onmessage = (message: MessageEvent) => {
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
