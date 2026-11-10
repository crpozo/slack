// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  leaveExternalCall,
  parseCallLink,
  startExternalCall,
  stopExternalCall,
  useExternalCall,
} from "./externalCall";
import { groupCalls, useGroupCall } from "./groupCall";

/** A socket the test drives: what the page sent, and server events in. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(frame: string) {
    this.sent.push(JSON.parse(frame) as Record<string, unknown>);
  }
  emit(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.readyState = 3;
  }
}

const start = (media: "audio" | "video" = "video") =>
  startExternalCall({
    wsUrl: "wss://ws.example.com",
    roomId: "room-1",
    token: "Y2g.secret-secret-secret",
    name: "  Ana  Cliente ",
    media,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
const lobby = (status: string) => ({
  type: "call.lobby",
  status,
  channelId: "ch_client",
  roomId: "room-1",
  userId: "ext_abc",
});

beforeEach(() => {
  FakeSocket.last = null;
  useExternalCall.setState({ status: "name", name: "", note: null });
  useGroupCall.setState({ call: null, rooms: {}, notice: null });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  stopExternalCall();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a call link", () => {
  it("names the call and carries its token", () => {
    expect(parseCallLink({ pathname: "/call/room-1", search: "?token=Y2g.abc" })).toEqual({
      roomId: "room-1",
      token: "Y2g.abc",
    });
    expect(parseCallLink({ pathname: "/call/room-1", search: "" })).toBeNull();
    expect(parseCallLink({ pathname: "/app/ch_general", search: "?token=x" })).toBeNull();
    expect(parseCallLink({ pathname: "/call/..%2Fapp", search: "?token=x" })).toBeNull();
  });
});

describe("joining from a call link", () => {
  it("connects as an external of that call (no session) and knocks", async () => {
    start();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    const url = new URL(FakeSocket.last!.url);
    expect(url.searchParams.get("token")).toBe("call:Y2g.secret-secret-secret");
    expect(url.searchParams.get("room")).toBe("room-1");
    expect(url.searchParams.get("name")).toBe("Ana Cliente");
    expect(url.searchParams.get("cid")).toMatch(/^[0-9a-f]{32}$/);
    FakeSocket.last!.open();
    expect(FakeSocket.last!.sent).toEqual([{ action: "call", signal: "knock" }]);
    expect(useExternalCall.getState()).toMatchObject({ status: "connecting", name: "Ana Cliente" });
  });

  it("waits in the lobby, then joins the call with the media they chose once let in", async () => {
    const join = vi.spyOn(groupCalls, "join").mockResolvedValue();
    start("audio");
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.open();
    FakeSocket.last!.emit(lobby("waiting"));
    expect(useExternalCall.getState().status).toBe("waiting");
    expect(join).not.toHaveBeenCalled();
    FakeSocket.last!.emit(lobby("admitted"));
    expect(useExternalCall.getState().status).toBe("in-call");
    expect(join).toHaveBeenCalledWith("ch_client", "audio");
  });

  it("says so when they're turned away or the call is over", async () => {
    start();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.open();
    FakeSocket.last!.emit(lobby("denied"));
    expect(useExternalCall.getState().status).toBe("denied");

    start();
    await vi.waitFor(() => expect(FakeSocket.last?.readyState).toBe(0));
    FakeSocket.last!.open();
    FakeSocket.last!.emit(lobby("ended"));
    expect(useExternalCall.getState().status).toBe("ended");
  });

  it("gives up when the link is refused (the socket never opens)", async () => {
    vi.useFakeTimers();
    start();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(useExternalCall.getState()).toMatchObject({ status: "ended" });
    expect(useExternalCall.getState().note).toMatch(/doesn't work anymore/);
  });

  it("asks for a name before connecting", () => {
    startExternalCall({
      wsUrl: "wss://ws.example.com",
      roomId: "room-1",
      token: "t",
      name: " <> ",
      media: "video",
    });
    expect(FakeSocket.last).toBeNull();
    expect(useExternalCall.getState()).toMatchObject({
      status: "name",
      note: "Type your name to join.",
    });
  });

  it("leaves on purpose", async () => {
    start();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    leaveExternalCall();
    expect(useExternalCall.getState().status).toBe("left");
  });
});
