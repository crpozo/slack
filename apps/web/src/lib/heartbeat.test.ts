import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_INTERVAL_MS, startHeartbeat } from "./heartbeat";
import type { WsStatus } from "./ws";

function fakeClient(status: WsStatus = "idle") {
  const handlers = new Set<(status: WsStatus) => void>();
  return {
    status,
    ping: vi.fn(),
    onStatus(handler: (status: WsStatus) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    setStatus(next: WsStatus) {
      this.status = next;
      handlers.forEach((h) => h(next));
    },
    get listeners() {
      return handlers.size;
    },
  };
}

describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings every 3 minutes while the socket is open", () => {
    const client = fakeClient("open");
    startHeartbeat(client);

    expect(HEARTBEAT_INTERVAL_MS).toBe(180_000);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(client.ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(client.ping).toHaveBeenCalledWith({});
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(client.ping).toHaveBeenCalledTimes(3);
  });

  it("sends nothing while connecting or reconnecting, and restarts on reconnect", () => {
    const client = fakeClient("connecting");
    startHeartbeat(client, undefined, 1000);

    vi.advanceTimersByTime(5000);
    expect(client.ping).not.toHaveBeenCalled();

    client.setStatus("open");
    vi.advanceTimersByTime(2500);
    expect(client.ping).toHaveBeenCalledTimes(2);

    client.setStatus("reconnecting");
    vi.advanceTimersByTime(5000);
    expect(client.ping).toHaveBeenCalledTimes(2); // nothing queued while offline

    client.setStatus("open");
    vi.advanceTimersByTime(999);
    expect(client.ping).toHaveBeenCalledTimes(2); // the interval restarted from zero
    vi.advanceTimersByTime(1);
    expect(client.ping).toHaveBeenCalledTimes(3);
  });

  it("stops and unsubscribes when told to", () => {
    const client = fakeClient("open");
    const stop = startHeartbeat(client, undefined, 1000);
    vi.advanceTimersByTime(1000);
    expect(client.ping).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(10_000);
    client.setStatus("open");
    vi.advanceTimersByTime(10_000);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.listeners).toBe(0);
  });

  it("reports whether the app is active: right away on open, then with every ping", () => {
    const client = fakeClient("open");
    let active = true;
    startHeartbeat(client, () => active, 1000);
    expect(client.ping).toHaveBeenLastCalledWith({ active: true });
    active = false;
    vi.advanceTimersByTime(1000);
    expect(client.ping).toHaveBeenLastCalledWith({ active: false });
    client.setStatus("reconnecting");
    client.setStatus("open");
    expect(client.ping).toHaveBeenCalledTimes(3);
  });
});
