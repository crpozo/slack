import type { CallEvent, CallRoom, CallRoomEvent } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupCallManager, JOIN_TIMEOUT_MS, useGroupCall, type GroupCallDeps } from "./groupCall";

// --- Minimal WebRTC / media fakes ----------------------------------------------

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(readonly kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: "d" };
  }
  addEventListener() {}
}
class FakeStream {
  private readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
}
class FakeChannel {
  readyState = "connecting";
  sent: string[] = [];
  addEventListener() {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = "closed";
  }
}
class FakePc {
  static all: FakePc[] = [];
  signalingState = "stable";
  iceConnectionState = "new";
  connectionState = "new";
  remoteDescription: unknown = null;
  localDescription: unknown = null;
  closed = false;
  transceivers: Array<{
    sender: { replaceTrack: ReturnType<typeof vi.fn>; setStreams?: () => void };
    receiver: { track: { kind: string } };
    direction: string;
  }> = [];
  added: unknown[] = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor() {
    FakePc.all.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, e: unknown = {}) {
    this.listeners[type]?.forEach((fn) => fn(e));
  }
  addTransceiver(trackOrKind: FakeTrack | string) {
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const t = {
      sender: { replaceTrack: vi.fn(async () => {}), setStreams() {} },
      receiver: { track: { kind } },
      direction: "sendrecv",
    };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    if (this.transceivers.length === 0) {
      for (const kind of ["audio", "video", "video"]) this.addTransceiver(kind);
    }
    return this.transceivers;
  }
  createOffer = async () => ({ type: "offer", sdp: "offer-sdp" });
  createAnswer = async () => ({ type: "answer", sdp: "answer-sdp" });
  setLocalDescription = async (d: { type: string }) => {
    this.localDescription = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
  };
  setRemoteDescription = async (d: { type: string }) => {
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  };
  addIceCandidate = vi.fn(async (c: unknown) => {
    this.added.push(c);
  });
  createDataChannel() {
    return new FakeChannel();
  }
  restartIce() {}
  close() {
    this.closed = true;
  }
}

// --- Harness --------------------------------------------------------------------------

const ME = "u-me";
const CH = "ch_proj";

function setup(overrides: Partial<Omit<GroupCallDeps, "send">> = {}) {
  const send = vi.fn();
  const deps = {
    send,
    myUserId: () => ME,
    nameOf: (id: string) => id.replace("u-", ""),
    notify: vi.fn(),
    postMessage: vi.fn(),
    dmCallActive: () => false,
    onStarted: vi.fn(),
    ...overrides,
  } satisfies GroupCallDeps;
  const manager = new GroupCallManager();
  manager.attach(deps);
  const sent = (): Array<Record<string, unknown>> =>
    send.mock.calls.map(([p]) => p as Record<string, unknown>);
  return { manager, deps, sent };
}

const room = (ids: string[], roomId = "room-1"): CallRoom => ({
  channelId: CH,
  roomId,
  startedAt: Date.now() - 60_000,
  startedBy: ids[0]!,
  participants: ids.map((userId, i) => ({ userId, joinedAt: i, media: "audio" as const })),
});
const roomEvent = (
  change: CallRoomEvent["change"],
  userId: string,
  ids: string[] | null,
  extra: Partial<CallRoomEvent> = {},
): CallRoomEvent => ({
  type: "call.room",
  channelId: CH,
  room: ids ? room(ids) : null,
  change,
  userId,
  ...extra,
});
const signal = (e: Partial<CallEvent> & { type: CallEvent["type"]; from: string }): CallEvent =>
  ({ callId: "room-1", channelId: CH, ...e }) as CallEvent;

async function seated(others: string[]) {
  const h = setup();
  await h.manager.join(CH, "audio");
  h.manager.onRoom(roomEvent("joined", ME, [...others, ME]));
  await vi.waitFor(() => expect(FakePc.all.length).toBe(others.length));
  return h;
}

beforeEach(() => {
  FakePc.all = [];
  useGroupCall.setState({ call: null, rooms: {}, notice: null });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval"] });
  vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
        const tracks = [new FakeTrack("audio")];
        if (c.video) tracks.push(new FakeTrack("video"));
        return new FakeStream(tracks);
      }),
    },
  });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("RTCPeerConnection", FakePc);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Tests --------------------------------------------------------------------------

describe("joining a channel call", () => {
  it("asks to join, then offers a connection to everyone already in the room", async () => {
    const { manager, sent } = setup();
    await manager.join(CH, "video");
    expect(sent()).toEqual([{ signal: "join", channelId: CH, media: "video" }]);
    expect(useGroupCall.getState().call).toMatchObject({ phase: "joining", camOn: true });

    manager.onRoom(roomEvent("joined", ME, ["u-ana", "u-luis", ME]));
    await vi.waitFor(() => expect(sent().filter((p) => p.signal === "offer")).toHaveLength(2));
    expect(sent().filter((p) => p.signal === "offer")).toEqual([
      {
        signal: "offer",
        media: "video",
        sdp: "offer-sdp",
        channelId: CH,
        callId: "room-1",
        to: "u-ana",
      },
      {
        signal: "offer",
        media: "video",
        sdp: "offer-sdp",
        channelId: CH,
        callId: "room-1",
        to: "u-luis",
      },
    ]);
    const call = useGroupCall.getState().call!;
    expect(call.phase).toBe("joined");
    expect(call.peers.map((p) => [p.userId, p.state])).toEqual([
      ["u-ana", "connecting"],
      ["u-luis", "connecting"],
    ]);
  });

  it("starting one: alone in the room, nobody to offer to", async () => {
    const { manager, sent } = setup();
    await manager.join(CH, "audio");
    manager.onRoom(roomEvent("started", ME, [ME]));
    expect(sent().filter((p) => p.signal === "offer")).toEqual([]);
    expect(useGroupCall.getState().call?.phase).toBe("joined");
    expect(useGroupCall.getState().notice).toBeNull(); // no notice for your own call
  });

  it("refuses while in a DM call, in another call, or when the room is full", async () => {
    const dm = setup({ dmCallActive: () => true });
    await dm.manager.join(CH, "audio");
    expect(dm.deps.notify).toHaveBeenCalledWith("You're already in a call.");
    expect(dm.deps.send).not.toHaveBeenCalled();

    useGroupCall.setState({
      rooms: { [CH]: room(["a", "b", "c", "d", "e", "f"]) },
    });
    const full = setup();
    await full.manager.join(CH, "audio");
    expect(full.deps.notify).toHaveBeenCalledWith(expect.stringMatching(/full/));
    expect(full.deps.send).not.toHaveBeenCalled();
  });

  it("gives up if the server never seats it", async () => {
    const { manager, deps } = setup();
    await manager.join(CH, "audio");
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
    expect(useGroupCall.getState().call).toBeNull();
    expect(deps.notify).toHaveBeenCalledWith("Couldn't join the call. Please try again.");
  });
});

describe("the mesh", () => {
  it("a newcomer's offer gets an answer; candidates before it are kept", async () => {
    const { manager, sent } = await seated(["u-ana"]);
    const candidate = { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0" };
    manager.handle(signal({ type: "call.ice_candidate", from: "u-dan", candidate }));
    manager.handle(signal({ type: "call.offer", from: "u-dan", media: "audio", sdp: "dan-offer" }));
    await vi.waitFor(() => expect(sent().some((p) => p.signal === "answer")).toBe(true));
    expect(sent().find((p) => p.signal === "answer")).toEqual({
      signal: "answer",
      sdp: "answer-sdp",
      channelId: CH,
      callId: "room-1",
      to: "u-dan",
    });
    const dan = FakePc.all[1]!;
    await vi.waitFor(() => expect(dan.added).toEqual([candidate]));
  });

  it("routes answers and restarts to the right pair; other rooms' signals are ignored", async () => {
    const { manager } = await seated(["u-ana", "u-luis"]);
    const [ana, luis] = FakePc.all as [FakePc, FakePc];
    manager.handle(signal({ type: "call.answer", from: "u-luis", sdp: "luis-answer" }));
    await vi.waitFor(() =>
      expect(luis.remoteDescription).toEqual({ type: "answer", sdp: "luis-answer" }),
    );
    expect(ana.remoteDescription).toBeNull();
    manager.handle({
      ...signal({ type: "call.answer", from: "u-ana", sdp: "x" }),
      callId: "room-old",
    } as CallEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(ana.remoteDescription).toBeNull();
  });

  it("someone leaving closes their connection only", async () => {
    const { manager } = await seated(["u-ana", "u-luis"]);
    const [ana, luis] = FakePc.all as [FakePc, FakePc];
    manager.onRoom(roomEvent("left", "u-ana", ["u-luis", ME]));
    expect(ana.closed).toBe(true);
    expect(luis.closed).toBe(false);
    expect(useGroupCall.getState().call?.peers.map((p) => p.userId)).toEqual(["u-luis"]);
  });

  it("mute and camera go to every pair", async () => {
    const { manager } = await seated(["u-ana", "u-luis"]);
    await manager.toggleCamera();
    for (const pc of FakePc.all) {
      expect(pc.transceivers[1]!.sender.replaceTrack).toHaveBeenCalledWith(expect.any(FakeTrack));
    }
    manager.toggleMic();
    expect(useGroupCall.getState().call?.micOn).toBe(false);
  });
});

describe("leaving", () => {
  it("the last one out posts the summary", async () => {
    const { manager, sent, deps } = await seated([]);
    manager.leave();
    expect(sent().at(-1)).toEqual({ signal: "leave", channelId: CH, callId: "room-1" });
    expect(useGroupCall.getState().call).toBeNull();
    manager.onRoom(roomEvent("ended", ME, null, { startedAt: Date.now() - 125_000 }));
    expect(deps.postMessage).toHaveBeenCalledWith(CH, "📞 Call ended • 02:05");
  });

  it("leaving with others still there posts nothing", async () => {
    const { manager, deps } = await seated(["u-ana"]);
    manager.leave();
    manager.onRoom(roomEvent("left", ME, ["u-ana"]));
    manager.onRoom(roomEvent("ended", "u-ana", null, { startedAt: 0 }));
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(FakePc.all[0]!.closed).toBe(true);
  });
});

describe("staying in it", () => {
  it("someone else starting a call shows the notice, without ringing", () => {
    const { manager, deps } = setup();
    manager.onRoom(roomEvent("started", "u-ana", ["u-ana"]));
    expect(useGroupCall.getState().rooms[CH]?.participants).toHaveLength(1);
    expect(useGroupCall.getState().notice).toMatchObject({ channelId: CH, by: "u-ana" });
    expect(deps.onStarted).toHaveBeenCalledWith(expect.objectContaining({ by: "u-ana" }));
  });

  it("a reconnected socket keeps the seat (same room) and asks for the rooms", async () => {
    const { manager, sent } = await seated(["u-ana"]);
    manager.signalingReconnected();
    expect(sent().slice(-2)).toEqual([
      { signal: "rooms" },
      { signal: "join", channelId: CH, media: "audio", callId: "room-1" },
    ]);
    // Seated again: no new offer to someone we're already connected with.
    manager.onRoom(roomEvent("joined", ME, ["u-ana", ME]));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent().filter((p) => p.signal === "offer")).toHaveLength(1);
  });

  it("our seat freed behind our back (closed socket): we take it again", async () => {
    const { manager, sent } = await seated(["u-ana"]);
    manager.onRoom(roomEvent("left", ME, ["u-ana"]));
    expect(sent().at(-1)).toEqual({
      signal: "join",
      channelId: CH,
      media: "audio",
      callId: "room-1",
    });
  });

  it("a room that ended while we were away: the rejoin seats us in the new one", async () => {
    const { manager, deps, sent } = await seated(["u-ana"]);
    manager.signalingReconnected();
    // The rooms list can come back before the rejoin is seated: we stay.
    manager.setRooms([]);
    expect(useGroupCall.getState().call?.phase).toBe("joined");
    // Ana had left; our rejoin started a new room with just us.
    manager.onRoom({
      ...roomEvent("started", ME, [ME]),
      room: { ...room([ME]), roomId: "room-2" },
    });
    const call = useGroupCall.getState().call!;
    expect(call.roomId).toBe("room-2");
    expect(call.peers).toEqual([]);
    expect(FakePc.all[0]!.closed).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(
      sent()
        .filter((p) => p.signal === "join")
        .at(-1),
    ).toMatchObject({ callId: "room-1" });
  });
});
