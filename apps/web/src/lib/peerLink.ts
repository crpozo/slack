import { MAX_ICE_CANDIDATES_PER_SIGNAL, type IceCandidate } from "@mindfultech/shared";
import { parsePeerState, type PeerMediaState } from "./call";

// ---------------------------------------------------------------------------
// One person-to-person connection inside a channel call (Phase 36). A call
// of N people is a mesh: every pair has its own `PeerLink`, negotiated the
// way DM calls are (three transceivers, audio, camera, screen, so turning a
// camera on or sharing a screen is a `replaceTrack`, never a renegotiation;
// a negotiated data channel carries mic/camera/screen state), and restored
// after a network drop the way f34 restores DM calls (ICE restart over
// `renegotiate`, re-sent offers, retries with fresh candidates, perfect
// negotiation for crossing offers, 30 s limit).
//
// Who offers: the newcomer, to everyone already in the room; the others
// answer. Who drives restarts: the smaller user id of the pair (the other
// one is "polite" and yields when both offer).
// ---------------------------------------------------------------------------

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];
const ICE_BATCH_MS = 150;
/** How long a pair tries to get its connection back before it gives up. */
export const LINK_RECONNECT_TIMEOUT_MS = 30_000;
export const LINK_RESTART_DELAY_MS = 2_000;
const RESEND_MS = 2_000;
const RESEND_MAX_MS = 8_000;
export const LINK_RESTART_RETRY_MS = 8_000;
/** A pair that never connects gives up after this. */
export const LINK_CONNECT_TIMEOUT_MS = 30_000;
const MAX_PENDING_ICE = 200;
/** Above this many people, each video sender is held to `MESH_VIDEO_BITRATE` (bps). */
export const MESH_BITRATE_FROM = 4;
export const MESH_VIDEO_BITRATE = 500_000;

export type LinkSignal =
  | { signal: "offer"; media: "audio" | "video"; sdp: string }
  | { signal: "answer"; sdp: string }
  | { signal: "ice_candidates"; candidates: IceCandidate[] }
  | { signal: "renegotiate"; kind: "offer" | "answer"; sdp: string; restart: number };

export type LinkState = "connecting" | "connected" | "reconnecting";

export interface LocalTracks {
  mic: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
}

export interface PeerLinkOptions {
  peerId: string;
  /** The smaller user id of the pair drives ICE restarts; the other is polite. */
  polite: boolean;
  media: "audio" | "video";
  tracks: () => LocalTracks;
  /** Sends a signal to this peer; `key` replaces a queued one while offline. */
  send: (signal: LinkSignal, key?: string) => void;
  /** Something the UI shows changed (streams, state, the peer's media). */
  onChange: () => void;
  /** The pair couldn't (re)connect in time: the manager drops it. */
  onLost: () => void;
  trace?: (step: string, detail?: Record<string, unknown>) => void;
}

/** The screen is the second video m-line: audio, camera, screen. */
function isScreenTransceiver(pc: RTCPeerConnection, transceiver: RTCRtpTransceiver): boolean {
  const videos = pc.getTransceivers().filter((t) => t.receiver.track.kind === "video");
  return videos.indexOf(transceiver) === 1;
}

export class PeerLink {
  readonly peerId: string;
  readonly pc: RTCPeerConnection;
  readonly control: RTCDataChannel;
  readonly remote = new MediaStream();
  readonly remoteScreen = new MediaStream();
  peer: PeerMediaState;
  state: LinkState = "connecting";
  /** When the connection dropped (epoch ms), while restoring it. */
  reconnectingSince: number | null = null;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  private screenSender: RTCRtpSender | null = null;
  private outgoingIce: IceCandidate[] = [];
  private pendingIce: RTCIceCandidateInit[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restarts = 0;
  private peerRestart = 0;
  private makingOffer = false;
  private everConnected = false;
  private closed = false;
  private readonly o: PeerLinkOptions;

  constructor(options: PeerLinkOptions) {
    this.o = options;
    this.peerId = options.peerId;
    this.peer = { micOn: true, camOn: options.media === "video", sharing: false };
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.addEventListener("icecandidate", ({ candidate }) => {
      if (!candidate?.candidate) return this.flushOutgoingIce();
      if (this.outgoingIce.length === 0) this.later(ICE_BATCH_MS, () => this.flushOutgoingIce());
      this.outgoingIce.push({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      });
      if (this.outgoingIce.length >= MAX_ICE_CANDIDATES_PER_SIGNAL) this.flushOutgoingIce();
    });
    pc.addEventListener("track", ({ track, transceiver }) => {
      const target = isScreenTransceiver(pc, transceiver) ? this.remoteScreen : this.remote;
      if (!target.getTracks().includes(track)) target.addTrack(track);
      this.o.onChange();
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      this.trace(`ice ${pc.iceConnectionState}`);
      this.onIceState(pc.iceConnectionState);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") this.connected();
      else if (pc.connectionState === "failed") {
        if (this.everConnected) this.beginReconnect(0);
        else this.lost("never connected");
      }
    });
    const control = pc.createDataChannel("control", { negotiated: true, id: 0 });
    this.control = control;
    control.addEventListener("open", () => this.sendState());
    control.addEventListener("message", ({ data }) => {
      const state = parsePeerState(data);
      if (!state) return;
      this.peer = state;
      this.o.onChange();
    });
    // A pair that never gets there doesn't hold the call's view forever.
    this.later(LINK_CONNECT_TIMEOUT_MS, () => {
      if (!this.everConnected) this.lost("connect timeout");
    });
  }

  private trace(step: string, detail?: Record<string, unknown>) {
    this.o.trace?.(step, { peer: this.peerId, ...detail });
  }

  /** The newcomer's side: transceivers for audio, camera and screen, then the offer. */
  async start(): Promise<void> {
    const t = this.o.tracks();
    const local = new MediaStream([t.mic, t.camera].filter((x): x is MediaStreamTrack => !!x));
    this.audioSender = this.pc.addTransceiver(t.mic ?? "audio", {
      direction: "sendrecv",
      streams: [local],
    }).sender;
    this.videoSender = this.pc.addTransceiver(t.camera ?? "video", {
      direction: "sendrecv",
      streams: [local],
    }).sender;
    this.screenSender = this.pc.addTransceiver(t.screen ?? "video", {
      direction: "sendrecv",
      streams: [local],
    }).sender;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.closed) return;
    this.o.send({ signal: "offer", media: this.o.media, sdp: offer.sdp ?? "" });
  }

  /** The others' side: answer the newcomer's offer, mapping audio, camera, screen. */
  async acceptOffer(sdp: string): Promise<void> {
    const pc = this.pc;
    await pc.setRemoteDescription({ type: "offer", sdp });
    const t = this.o.tracks();
    const local = new MediaStream([t.mic, t.camera].filter((x): x is MediaStreamTrack => !!x));
    let videos = 0;
    const swaps: Promise<void>[] = [];
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind;
      transceiver.direction = "sendrecv";
      transceiver.sender.setStreams?.(local);
      if (kind === "audio") {
        swaps.push(transceiver.sender.replaceTrack(t.mic));
        this.audioSender = transceiver.sender;
      } else if (videos++ === 0) {
        swaps.push(transceiver.sender.replaceTrack(t.camera));
        this.videoSender = transceiver.sender;
      } else {
        swaps.push(transceiver.sender.replaceTrack(t.screen));
        this.screenSender = transceiver.sender;
      }
    }
    await Promise.all(swaps);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (this.closed) return;
    this.o.send({ signal: "answer", sdp: answer.sdp ?? "" });
    await this.flushIncomingIce();
  }

  async receiveAnswer(sdp: string): Promise<void> {
    if (this.pc.signalingState !== "have-local-offer" || this.everConnected) return;
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.flushIncomingIce();
  }

  async receiveIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // During a restart it may belong to the peer's new credentials: keep it for then.
      if (
        this.reconnectingSince !== null &&
        candidate.usernameFragment &&
        this.pendingIce.length < MAX_PENDING_ICE
      ) {
        this.pendingIce.push(candidate);
      }
    }
  }

  /** Swaps what this pair sends (`null` stops sending it). */
  async replaceTrack(kind: "audio" | "camera" | "screen", track: MediaStreamTrack | null) {
    const sender =
      kind === "audio"
        ? this.audioSender
        : kind === "camera"
          ? this.videoSender
          : this.screenSender;
    await sender?.replaceTrack(track);
  }

  /** Mesh: with many people, each video sender is held to a bitrate everyone can upload. */
  async limitVideo(people: number): Promise<void> {
    const maxBitrate = people >= MESH_BITRATE_FROM ? MESH_VIDEO_BITRATE : undefined;
    for (const sender of [this.videoSender, this.screenSender]) {
      if (!sender?.getParameters || !sender.setParameters) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) continue;
        params.encodings = params.encodings.map((e) => ({ ...e, maxBitrate }));
        await sender.setParameters(params);
      } catch {
        // Not negotiated yet; the next change of size applies it.
      }
    }
  }

  /** Tells the peer my mic, camera and screen state. */
  sendState(state?: { micOn: boolean; camOn: boolean; sharing: boolean }): void {
    if (this.control.readyState !== "open") return;
    const t = this.o.tracks();
    const s = state ?? { micOn: !!t.mic?.enabled, camOn: !!t.camera, sharing: !!t.screen };
    try {
      this.control.send(JSON.stringify(s));
    } catch {
      // Closing.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.clearReconnect();
    try {
      this.control.close();
    } catch {
      // Already closed.
    }
    this.pc.close();
  }

  // --- Reconnecting (as DM calls do, Phase 34) -------------------------------------

  private get drivesRestarts(): boolean {
    return !this.o.polite;
  }

  private connected(): void {
    if (!this.everConnected) {
      this.everConnected = true;
      this.state = "connected";
      this.o.onChange();
    }
    this.reconnected();
  }

  private onIceState(state: RTCIceConnectionState): void {
    if (this.closed) return;
    if (state === "connected" || state === "completed") this.connected();
    else if (state === "disconnected" && this.everConnected) {
      this.beginReconnect(LINK_RESTART_DELAY_MS);
    } else if (state === "failed") {
      if (this.everConnected) this.beginReconnect(0);
      else this.lost("ice failed");
    }
  }

  private beginReconnect(delay: number): void {
    if (this.reconnectingSince === null) {
      this.reconnectingSince = Date.now();
      this.state = "reconnecting";
      this.trace("reconnecting");
      this.reconnectLater(LINK_RECONNECT_TIMEOUT_MS, () => this.lost("reconnect timeout"));
      this.o.onChange();
    }
    if (this.drivesRestarts) this.scheduleRestart(delay);
  }

  private reconnected(): void {
    if (this.reconnectingSince === null) return;
    this.trace("reconnected", { afterMs: Date.now() - this.reconnectingSince });
    this.reconnectingSince = null;
    this.state = "connected";
    this.clearReconnect();
    this.o.onChange();
    this.sendState();
  }

  /** The signaling socket (or the network) came back: restart or re-send now. */
  networkBack(): void {
    if (this.reconnectingSince === null || this.closed) return;
    if (this.pc.signalingState === "have-local-offer" && this.restarts > 0) {
      this.sendRestartOffer(this.restarts);
    } else {
      this.scheduleRestart(0);
    }
  }

  private lost(why: string): void {
    if (this.closed) return;
    this.trace("lost", { why });
    this.o.onLost();
  }

  private clearReconnect(): void {
    this.reconnectTimers.forEach((t) => clearTimeout(t));
    this.reconnectTimers.clear();
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(timer);
  }

  private reconnectLater(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(timer);
      if (!this.closed && this.reconnectingSince !== null) fn();
    }, ms);
    this.reconnectTimers.add(timer);
  }

  private scheduleRestart(delay: number): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restartIce();
    }, delay);
  }

  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (this.closed || this.reconnectingSince === null) return;
    if (this.drivesRestarts) this.scheduleRestart(LINK_RESTART_RETRY_MS);
    try {
      if (pc.signalingState === "have-local-offer") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      if (pc.signalingState !== "stable") return;
      this.makingOffer = true;
      const restart = this.restarts + 1;
      pc.restartIce?.();
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.closed || pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      this.restarts = restart;
      this.trace("ice restart", { restart });
      this.sendRestartOffer(restart);
    } catch (err) {
      this.trace("ice restart failed", { error: String(err) });
    } finally {
      this.makingOffer = false;
    }
  }

  private sendRestartOffer(restart: number, wait = RESEND_MS): void {
    const pc = this.pc;
    if (this.closed || this.reconnectingSince === null) return;
    if (pc.signalingState !== "have-local-offer" || this.restarts !== restart) return;
    this.o.send(
      { signal: "renegotiate", kind: "offer", sdp: pc.localDescription?.sdp ?? "", restart },
      `restart-offer:${this.peerId}`,
    );
    this.reconnectLater(wait, () =>
      this.sendRestartOffer(restart, Math.min(wait * 2, RESEND_MAX_MS)),
    );
  }

  async receiveRenegotiate(kind: "offer" | "answer", sdp: string, restart: number): Promise<void> {
    const pc = this.pc;
    if (!pc.remoteDescription || this.closed) return;
    if (kind === "answer") {
      if (pc.signalingState !== "have-local-offer" || restart !== this.restarts) return;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp });
        await this.flushIncomingIce();
      } catch (err) {
        this.trace("restart answer failed", { error: String(err) });
      }
      this.checkRestored();
      return;
    }
    if (restart < this.peerRestart) return;
    const collision = this.makingOffer || pc.signalingState !== "stable";
    if (collision && !this.o.polite) return; // ours goes first
    try {
      if (pc.signalingState === "have-local-offer") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (err) {
      this.trace("restart offer failed", { error: String(err) });
      return;
    }
    if (this.closed) return;
    this.peerRestart = restart;
    this.o.send(
      { signal: "renegotiate", kind: "answer", sdp: pc.localDescription?.sdp ?? "", restart },
      `restart-answer:${this.peerId}`,
    );
    await this.flushIncomingIce();
    this.checkRestored();
  }

  /** A path that still works keeps ICE `connected` through a restart, with no event. */
  private checkRestored(): void {
    const s = this.pc.iceConnectionState;
    if (this.reconnectingSince !== null && (s === "connected" || s === "completed")) {
      this.reconnected();
    }
  }

  private flushOutgoingIce(): void {
    if (this.closed || this.outgoingIce.length === 0) return;
    const candidates = this.outgoingIce;
    this.outgoingIce = [];
    this.o.send({ signal: "ice_candidates", candidates });
  }

  private async flushIncomingIce(): Promise<void> {
    const pending = this.pendingIce.splice(0);
    await Promise.all(pending.map((c) => this.receiveIce(c)));
  }
}
