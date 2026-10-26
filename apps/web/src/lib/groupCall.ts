import {
  MAX_ROOM_PARTICIPANTS,
  type CallEvent,
  type CallMedia,
  type CallRoom,
  type CallRoomEvent,
  type ClientActionInput,
} from "@mindfultech/shared";
import { create } from "zustand";
import { formatCallDuration } from "./call";
import { getUserMediaWithFallback, mediaErrorText } from "./media";
import { PeerLink, type LinkSignal, type LinkState } from "./peerLink";
import type { DistributiveOmit } from "./ws";

// ---------------------------------------------------------------------------
// Channel calls (Phase 36): a room per channel, joined from the channel's
// header, holding up to six people in a mesh. Each other person is a
// `PeerLink`. DM calls stay on `CallManager` (`call.ts`), untouched; one
// call at a time across both.
//
// Joining: `join` seats us (the server answers everyone in the channel with
// `call.room`); then we offer a connection to everyone already there. Those
// who join later offer to us. Nothing rings: the channel's people see the
// call in its header (and an in-app notice when it starts). The last one to
// leave posts the "call ended" summary in the channel.
// ---------------------------------------------------------------------------

/** How long joining may take before giving up. */
export const JOIN_TIMEOUT_MS = 15_000;

/** One other person in the call, as the UI shows them. */
export interface GroupPeerView {
  userId: string;
  /** `waiting`: in the room, their connection to us not offered yet (they just joined). */
  state: LinkState | "waiting";
  stream: MediaStream | null;
  screen: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  /** When they stop being restored (epoch ms), while reconnecting. */
  reconnectingUntil: number | null;
}

export interface GroupCallView {
  channelId: string;
  roomId: string | null;
  phase: "joining" | "joined";
  media: CallMedia;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  /** The others, in the order they joined. */
  peers: GroupPeerView[];
  /** When the call started (epoch ms), for the timer. */
  startedAt: number | null;
}

/** A call someone else just started in one of your channels (the in-app notice). */
export interface CallStartedNotice {
  channelId: string;
  by: string;
  at: number;
}

export const useGroupCall = create<{
  call: GroupCallView | null;
  /** The calls going on in your channels, by channel. */
  rooms: Record<string, CallRoom>;
  notice: CallStartedNotice | null;
}>(() => ({ call: null, rooms: {}, notice: null }));

type CallInput = Extract<ClientActionInput, { action: "call" }>;
export type SendRoomSignal = (payload: DistributiveOmit<CallInput, "action">, key?: string) => void;

export interface GroupCallDeps {
  send: SendRoomSignal;
  myUserId: () => string | null;
  nameOf: (userId: string) => string;
  notify: (text: string) => void;
  /** Posts a chat message in the channel (the "call ended" summary). */
  postMessage: (channelId: string, text: string) => void;
  /** A DM call is going on (one call at a time). */
  dmCallActive: () => boolean;
  /** Someone else started a call in one of your channels. */
  onStarted?: (notice: CallStartedNotice) => void;
}

/** "📞 Call ended • 12:34" in the channel. */
export const roomSummaryText = (durationMs: number) =>
  `📞 Call ended • ${formatCallDuration(durationMs)}`;

interface RoomSession {
  channelId: string;
  roomId: string | null;
  phase: "joining" | "joined";
  media: CallMedia;
  mic: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  links: Map<string, PeerLink>;
  /** Their candidates that arrived before their offer. */
  pendingIce: Map<string, RTCIceCandidateInit[]>;
  joinTimer: ReturnType<typeof setTimeout> | undefined;
  cameraPreview: { track: MediaStreamTrack; stream: MediaStream } | null;
  screenPreview: { track: MediaStreamTrack; stream: MediaStream } | null;
}

const trace = (step: string, detail?: Record<string, unknown>) =>
  console.info("[room]", step, detail ?? "");

export class GroupCallManager {
  private deps: GroupCallDeps | null = null;
  private session: RoomSession | null = null;
  /** The room we just left: if we were the last, the `ended` event says so and we post the summary. */
  private justLeft: { channelId: string; roomId: string; at: number } | null = null;
  private readonly onPageHide = () => this.leave();
  private readonly onOnline = () => this.session?.links.forEach((l) => l.networkBack());

  attach(deps: GroupCallDeps): void {
    this.deps = deps;
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("online", this.onOnline);
  }

  detach(): void {
    this.leave();
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("online", this.onOnline);
    this.deps = null;
    useGroupCall.setState({ call: null, rooms: {}, notice: null });
  }

  get busy(): boolean {
    return this.session !== null;
  }

  /** The channel this device is in a call in, if any. */
  get channelId(): string | null {
    return this.session?.channelId ?? null;
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  async join(channelId: string, media: CallMedia): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    if (this.session?.channelId === channelId) return;
    if (this.session || deps.dmCallActive()) {
      deps.notify("You're already in a call.");
      return;
    }
    const room = useGroupCall.getState().rooms[channelId];
    if (room && room.participants.length >= MAX_ROOM_PARTICIPANTS) {
      deps.notify(`That call is full: it holds up to ${MAX_ROOM_PARTICIPANTS} people.`);
      return;
    }
    const session: RoomSession = {
      channelId,
      roomId: null,
      phase: "joining",
      media,
      mic: null,
      camera: null,
      screen: null,
      links: new Map(),
      pendingIce: new Map(),
      joinTimer: undefined,
      cameraPreview: null,
      screenPreview: null,
    };
    this.session = session;
    this.publish();
    try {
      const stream = await getUserMediaWithFallback({ audio: true, video: media === "video" });
      if (this.session !== session) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      session.mic = stream.getAudioTracks()[0] ?? null;
      session.camera = stream.getVideoTracks()[0] ?? null;
    } catch (err) {
      this.finish(mediaErrorText(err, media === "video" ? "camera or microphone" : "microphone"));
      return;
    }
    deps.send({ signal: "join", channelId, media });
    session.joinTimer = setTimeout(() => {
      if (this.session === session && session.phase === "joining") {
        this.finish("Couldn't join the call. Please try again.");
      }
    }, JOIN_TIMEOUT_MS);
    this.publish();
  }

  /** Leaves the call (the last one out ends it). */
  leave(): void {
    const session = this.session;
    if (!session) return;
    if (session.roomId) {
      this.deps?.send({ signal: "leave", channelId: session.channelId, callId: session.roomId });
      this.justLeft = { channelId: session.channelId, roomId: session.roomId, at: Date.now() };
    }
    this.finish(null);
  }

  toggleMic(): void {
    const session = this.session;
    if (!session?.mic) return;
    session.mic.enabled = !session.mic.enabled;
    this.broadcastState();
    this.publish();
  }

  async toggleCamera(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.camera) {
      session.camera.stop();
      session.camera = null;
      await this.replaceEverywhere("camera", null);
    } else {
      try {
        const stream = await getUserMediaWithFallback({ audio: false, video: true });
        const [track] = stream.getVideoTracks();
        if (this.session !== session || !track) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        session.camera = track;
        await this.replaceEverywhere("camera", track);
      } catch (err) {
        this.deps?.notify(mediaErrorText(err, "camera"));
        return;
      }
    }
    this.broadcastState();
    this.publish();
  }

  async toggleScreenShare(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.screen) {
      await this.stopScreenShare(session);
      return;
    }
    let track: MediaStreamTrack | undefined;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      track = stream.getVideoTracks()[0];
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      this.deps?.notify(mediaErrorText(err, "screen"));
      return;
    }
    if (!track) return;
    if (this.session !== session) {
      track.stop();
      return;
    }
    track.contentHint = "detail";
    track.addEventListener("ended", () => {
      if (session.screen === track) void this.stopScreenShare(session);
    });
    session.screen = track;
    await this.replaceEverywhere("screen", track);
    this.broadcastState();
    this.publish();
  }

  // ---------------------------------------------------------------------------
  // From the server
  // ---------------------------------------------------------------------------

  /** `call.rooms`: the calls going on in your channels (after connecting). */
  setRooms(rooms: CallRoom[]): void {
    // A live session isn't ended from here: after a reconnect this list can be
    // read before our rejoin is seated, and the rejoin (same room, or a new one
    // if ours ended meanwhile) is what says where we are.
    useGroupCall.setState({ rooms: Object.fromEntries(rooms.map((r) => [r.channelId, r])) });
    this.publish();
  }

  /** `call.room`: a channel's call changed. */
  onRoom(event: CallRoomEvent): void {
    const deps = this.deps;
    const me = deps?.myUserId();
    if (!deps || !me) return;
    useGroupCall.setState((s) => {
      const rooms = { ...s.rooms };
      if (event.room) rooms[event.channelId] = event.room;
      else delete rooms[event.channelId];
      return { rooms };
    });

    if (event.change === "started" && event.userId !== me) {
      const notice = { channelId: event.channelId, by: event.userId, at: Date.now() };
      useGroupCall.setState({ notice });
      deps.onStarted?.(notice);
    }
    // We were the last one out: the summary is ours to post, once.
    const left = this.justLeft;
    if (
      event.change === "ended" &&
      event.userId === me &&
      left?.channelId === event.channelId &&
      event.startedAt !== undefined
    ) {
      this.justLeft = null;
      deps.postMessage(event.channelId, roomSummaryText(Date.now() - event.startedAt));
    }

    const session = this.session;
    if (session?.channelId !== event.channelId) return;
    if (!event.room) {
      this.finish("The call ended.");
      return;
    }
    const room = event.room;
    const seated = room.participants.some((p) => p.userId === me);
    if (event.userId === me && (event.change === "started" || event.change === "joined")) {
      // Seated (or seated again after the socket reconnected): offer to everyone
      // we have no connection with yet.
      clearTimeout(session.joinTimer);
      session.roomId = room.roomId;
      session.phase = "joined";
      for (const p of room.participants) {
        if (p.userId === me || session.links.has(p.userId)) continue;
        const link = this.createLink(session, p.userId);
        void link.start().catch((err: unknown) => {
          trace("offer failed", { peer: p.userId, error: String(err) });
          this.dropLink(session, p.userId, false);
        });
      }
    } else if (session.phase === "joined" && !seated && event.change === "left") {
      // Our seat was freed (this socket closed and reconnected): take it again.
      this.rejoin();
    }
    // Whoever is no longer in the room: their connection goes.
    for (const userId of session.links.keys()) {
      if (!room.participants.some((p) => p.userId === userId))
        this.dropLink(session, userId, false);
    }
    void this.limitBitrates(room.participants.length);
    this.publish();
  }

  /** A signal from someone in our room (offer, answer, candidates, restarts). */
  handle(event: CallEvent): void {
    const session = this.session;
    if (!session || session.channelId !== event.channelId) return;
    // An offer can beat our own `joined` event: it names the room.
    if (session.roomId === null && session.phase === "joining") session.roomId = event.callId;
    if (event.callId !== session.roomId) return;
    const from = event.from;
    switch (event.type) {
      case "call.offer": {
        // A newcomer (or someone who reloaded): a fresh connection with them.
        this.dropLink(session, from, false);
        const link = this.createLink(session, from);
        const pending = session.pendingIce.get(from) ?? [];
        session.pendingIce.delete(from);
        void link
          .acceptOffer(event.sdp)
          .then(() => Promise.all(pending.map((c) => link.receiveIce(c))))
          .catch((err: unknown) => {
            trace("answer failed", { peer: from, error: String(err) });
            this.dropLink(session, from, true);
          });
        break;
      }
      case "call.answer":
        void session.links.get(from)?.receiveAnswer(event.sdp);
        break;
      case "call.ice_candidate": {
        const link = session.links.get(from);
        if (link) void link.receiveIce(event.candidate);
        else {
          const list = session.pendingIce.get(from) ?? [];
          if (list.length < 200) list.push(event.candidate);
          session.pendingIce.set(from, list);
        }
        break;
      }
      case "call.renegotiate":
        void session.links.get(from)?.receiveRenegotiate(event.kind, event.sdp, event.restart);
        break;
      default:
        break; // rooms are left with `leave`, never ended by a signal
    }
  }

  /** The socket reconnected: keep our seat (its connection changed) and restore the pairs. */
  signalingReconnected(): void {
    this.deps?.send({ signal: "rooms" });
    this.rejoin();
    this.session?.links.forEach((l) => l.networkBack());
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private rejoin(): void {
    const session = this.session;
    if (!session || !this.deps) return;
    this.deps.send({
      signal: "join",
      channelId: session.channelId,
      media: session.media,
      ...(session.roomId && { callId: session.roomId }),
    });
  }

  private createLink(session: RoomSession, peerId: string): PeerLink {
    const me = this.deps?.myUserId() ?? "";
    const link = new PeerLink({
      peerId,
      polite: me > peerId,
      media: session.media,
      tracks: () => ({ mic: session.mic, camera: session.camera, screen: session.screen }),
      send: (signal: LinkSignal, key?: string) => {
        if (!session.roomId || this.session !== session) return;
        this.deps?.send(
          { ...signal, channelId: session.channelId, callId: session.roomId, to: peerId },
          key && `room:${session.roomId}:${key}`,
        );
      },
      onChange: () => {
        if (this.session === session) this.publish();
      },
      onLost: () => {
        if (this.session !== session) return;
        this.deps?.notify(`Lost the connection to ${this.deps.nameOf(peerId)}.`);
        this.dropLink(session, peerId, false);
        this.publish();
      },
      trace: (step, detail) => trace(step, detail),
    });
    session.links.set(peerId, link);
    return link;
  }

  private dropLink(session: RoomSession, peerId: string, publish: boolean): void {
    const link = session.links.get(peerId);
    if (!link) return;
    link.close();
    session.links.delete(peerId);
    session.pendingIce.delete(peerId);
    if (publish) this.publish();
  }

  private async replaceEverywhere(kind: "camera" | "screen", track: MediaStreamTrack | null) {
    const session = this.session;
    if (!session) return;
    await Promise.all([...session.links.values()].map((l) => l.replaceTrack(kind, track)));
  }

  private async stopScreenShare(session: RoomSession): Promise<void> {
    session.screen?.stop();
    session.screen = null;
    await this.replaceEverywhere("screen", null);
    if (this.session !== session) return;
    this.broadcastState();
    this.publish();
  }

  private broadcastState(): void {
    this.session?.links.forEach((l) => l.sendState());
  }

  private async limitBitrates(people: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    await Promise.all([...session.links.values()].map((l) => l.limitVideo(people)));
  }

  private finish(notice: string | null): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.joinTimer);
    session.links.forEach((l) => l.close());
    for (const track of [session.mic, session.camera, session.screen]) track?.stop();
    this.publish();
    if (notice) this.deps?.notify(notice);
  }

  private publish(): void {
    const s = this.session;
    if (!s) {
      useGroupCall.setState({ call: null });
      return;
    }
    if (s.cameraPreview?.track !== s.camera) {
      s.cameraPreview = s.camera ? { track: s.camera, stream: new MediaStream([s.camera]) } : null;
    }
    if (s.screenPreview?.track !== s.screen) {
      s.screenPreview = s.screen ? { track: s.screen, stream: new MediaStream([s.screen]) } : null;
    }
    const me = this.deps?.myUserId();
    const room = useGroupCall.getState().rooms[s.channelId];
    const inRoom = room?.roomId === s.roomId ? room.participants : [];
    const ids = [
      ...inRoom.map((p) => p.userId).filter((id) => id !== me),
      ...[...s.links.keys()].filter((id) => !inRoom.some((p) => p.userId === id)),
    ];
    const peers: GroupPeerView[] = ids.map((userId) => {
      const link = s.links.get(userId);
      const media = inRoom.find((p) => p.userId === userId)?.media ?? "audio";
      if (!link) {
        return {
          userId,
          state: "waiting",
          stream: null,
          screen: null,
          micOn: true,
          camOn: media === "video",
          sharing: false,
          reconnectingUntil: null,
        };
      }
      return {
        userId,
        state: link.state,
        stream: link.remote.getTracks().length > 0 ? link.remote : null,
        screen: link.remoteScreen.getTracks().length > 0 ? link.remoteScreen : null,
        micOn: link.peer.micOn,
        camOn: link.peer.camOn,
        sharing: link.peer.sharing,
        reconnectingUntil: link.reconnectingSince === null ? null : link.reconnectingSince + 30_000,
      };
    });
    useGroupCall.setState({
      call: {
        channelId: s.channelId,
        roomId: s.roomId,
        phase: s.phase,
        media: s.media,
        micOn: s.mic?.enabled ?? true,
        camOn: !!s.camera,
        sharing: !!s.screen,
        localCamera: s.cameraPreview?.stream ?? null,
        localScreen: s.screenPreview?.stream ?? null,
        peers,
        startedAt: room?.roomId === s.roomId ? room.startedAt : null,
      },
    });
  }
}

export const groupCalls = new GroupCallManager();
