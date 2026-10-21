import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertWebSocketUrl, backoffDelay, PROBE_TIMEOUT_MS, WsClient } from "./ws";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("backoffDelay", () => {
  it("doubles from 1 s up to 30 s with jitter", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(10, () => 1)).toBe(30_000);
    expect(backoffDelay(10, () => 0)).toBe(15_000);
  });
});

describe("assertWebSocketUrl", () => {
  it("accepts wss:// anywhere and ws:// only on localhost", () => {
    expect(assertWebSocketUrl("wss://abc.execute-api.us-east-1.amazonaws.com/prod")).toBe(
      "wss://abc.execute-api.us-east-1.amazonaws.com/prod",
    );
    expect(assertWebSocketUrl("wss://ws.mindfultech.ec")).toBe("wss://ws.mindfultech.ec/");
    expect(assertWebSocketUrl("ws://localhost:8787")).toBe("ws://localhost:8787/");
    expect(assertWebSocketUrl("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/");
  });

  it("rejects anything else", () => {
    for (const bad of [
      "ws://evil.example",
      "https://ws.mindfultech.ec",
      "javascript:alert(1)",
      "wss://user:pass@ws.mindfultech.ec",
      "wss://ws.mindfultech.ec/?token=stolen",
      "wss://ws.mindfultech.ec/#x",
      "not a url",
      "",
    ]) {
      expect(() => assertWebSocketUrl(bad), bad).toThrow();
    }
  });

  it("is enforced by the client before connecting", () => {
    expect(() => new WsClient({ url: "ws://evil.example", getToken: async () => "t" })).toThrow(
      "wss://",
    );
  });
});

describe("WsClient", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const client = (getToken = () => Promise.resolve("tok")) =>
    new WsClient({
      url: "wss://ws.example",
      getToken,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 1,
    });

  it("connects with the token, queues frames until open and dispatches events", async () => {
    const ws = client();
    const received: unknown[] = [];
    ws.on("channel.list", (e) => received.push(e.channels));
    ws.connect();
    ws.send("channel", { op: "list" });
    await flush();

    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://ws.example/?token=tok");
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual(['{"action":"channel","op":"list"}']);

    socket.onmessage?.({ data: JSON.stringify({ type: "channel.list", channels: [1] }) });
    socket.onmessage?.({ data: "not json" });
    expect(received).toEqual([[1]]);
  });

  it("keeps one queued frame per key: a retried message is sent once on reconnect", async () => {
    const ws = client();
    ws.connect();
    const msg = (text: string) => ({ channelId: "ch_general", text, clientId: "c1" });
    ws.send("message", msg("first try"), "c1");
    ws.send("channel", { op: "list" });
    ws.send("message", msg("retry"), "c1");
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    expect(socket.sent.map((f) => JSON.parse(f) as { action: string; text?: string })).toEqual([
      { action: "channel", op: "list" },
      { action: "message", channelId: "ch_general", text: "retry", clientId: "c1" },
    ]);
  });

  it("reconnects with backoff and reports reconnected", async () => {
    vi.useFakeTimers();
    const ws = client();
    const opens: boolean[] = [];
    const statuses: string[] = [];
    ws.onOpen(({ reconnected }) => opens.push(reconnected));
    ws.onStatus((s) => statuses.push(s));
    ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop();

    expect(ws.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.open();

    expect(opens).toEqual([false, true]);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("reconnectNow skips the remaining backoff", async () => {
    vi.useFakeTimers();
    const ws = client();
    ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.drop();
    ws.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops and reports when the session is gone", async () => {
    const onSessionExpired = vi.fn();
    const ws = new WsClient({
      url: "wss://ws.example",
      getToken: () => Promise.reject(new Error("expired")),
      isSessionExpired: () => true,
      onSessionExpired,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    ws.connect();
    await flush();
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(ws.status).toBe("closed");
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("does not reconnect after disconnect()", async () => {
    vi.useFakeTimers();
    const ws = client();
    ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    ws.disconnect();
    FakeSocket.instances[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(ws.status).toBe("closed");
  });

  it("a probed socket that answers stays; one that stays silent is replaced and caught up", async () => {
    vi.useFakeTimers();
    const ws = client();
    const opens: boolean[] = [];
    const received: string[] = [];
    ws.onOpen(({ reconnected }) => opens.push(reconnected));
    ws.on("message.new", (e) => received.push(e.message.messageId));
    ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.instances[0]!;
    first.open();

    // Alive: the pong (any frame) arrives in time.
    ws.ping({ active: true });
    expect(JSON.parse(first.sent.at(-1)!)).toEqual({ action: "ping", active: true, probe: true });
    first.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(FakeSocket.instances).toHaveLength(1);

    // Dead: still "open", but nothing comes back. Replaced at once, as a reconnection.
    ws.ping({});
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(3);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(opens).toEqual([false, true]);
    expect(ws.status).toBe("open");

    // A late frame from the dead socket is ignored; the new one delivers.
    const event = (id: string) => ({
      data: JSON.stringify({ type: "message.new", message: { messageId: id } }),
    });
    first.onmessage?.(event("ghost"));
    second.onmessage?.(event("m1"));
    expect(received).toEqual(["m1"]);
  });

  it("a ping while not open starts the pending reconnect instead", async () => {
    vi.useFakeTimers();
    const ws = client();
    ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop();
    expect(ws.status).toBe("reconnecting");
    ws.ping({ active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
