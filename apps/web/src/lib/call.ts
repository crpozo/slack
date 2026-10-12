import type { CallEndReason, CallEvent, CallMedia, ClientActionInput } from "@mindfultech/shared";
import { ulid } from "ulid";
import { create } from "zustand";
import {
  getDeviceTrack,
  getUserMediaWithFallback,
  loadMediaPrefs,
  mediaErrorText,
  saveMediaPrefs,
} from "./media";
import { startRingtone, stopRingtone } from "./ringtone";
import type { DistributiveOmit } from "./ws";

/**
 * 1:1 WebRTC calls in DMs. The WebSocket (API Gateway + the `call` Lambda)
 * only relays the JSON signaling; audio and video flow peer to peer.
 *
 * Both sides always negotiate one audio and one video transceiver, so turning
 * the camera on in a voice call or sharing the screen is a `replaceTrack`, never
 * a renegotiation. A negotiated data channel carries each side's mic, camera
 * and screen state so the other side can show an avatar instead of black video.
 */

/** Free public STUN only: TURN relays media through a server, which costs money. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const RING_TIMEOUT_MS = 45_000;
const INCOMING_TIMEOUT_MS = 50_000;
const DISCONNECT_GRACE_MS = 10_000;

export type CallPhase = "outgoing" | "incoming" | "connecting" | "connected";

export interface PeerMediaState {
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
}

/** What the call UI renders; `null` when there is no call. */
export interface CallView {
  callId: string;
  channelId: string;
  peerId: string;
  media: CallMedia;
  phase: CallPhase;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  /** Camera or screen being sent, for the local picture-in-picture. */
  localVideo: MediaStream | null;
  remoteStream: MediaStream | null;
  peer: PeerMediaState;
  connectedAt: number | null;
  /** Devices currently captured (`null` while that input is off). */
  micDeviceId: string | null;
  cameraDeviceId: string | null;
}

export const useCall = create<{ call: CallView | null }>(() => ({ call: null }));

type CallInput = Extract<ClientActionInput, { action: "call" }>;
type SignalPayload = DistributiveOmit<CallInput, "action" | "callId" | "channelId" | "to">;
export type SendCallSignal = (payload: DistributiveOmit<CallInput, "action">) => void;

interface Session {
  callId: string;
  channelId: string;
  peerId: string;
  media: CallMedia;
  role: "caller" | "callee";
  phase: CallPhase;
  pc: RTCPeerConnection | null;
  control: RTCDataChannel | null;
  /** Callee only: the offer received while ringing. */
  offerSdp: string | null;
  /** Remote candidates that arrived before the remote description. */
  pendingIce: RTCIceCandidateInit[];
  mic: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  audioSender: RTCRtpSender | null;
  videoSender: RTCRtpSender | null;
  remote: MediaStream;
  /** Local picture-in-picture stream, rebuilt only when the sent video track changes. */
  preview: { track: MediaStreamTrack; stream: MediaStream } | null;
  peer: PeerMediaState;
  connectedAt: number | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface CallDeps {
  send: SendCallSignal;
  /** Posts a regular chat message (used for the "call ended" summary). */
  postMessage: (channelId: string, text: string) => void;
  myUserId: () => string | null;
  nameOf: (userId: string) => string;
  notify: (text: string) => void;
}

/** Toast shown when the other side ends or declines; `null` for none. */
export function endNotice(
  reason: CallEndReason,
  name: string,
  phase: CallPhase | null,
): string | null {
  switch (reason) {
    case "declined":
      return `${name} declined the call.`;
    case "busy":
      return `${name} is on another call.`;
    case "unavailable":
      return `${name} isn't online right now.`;
    case "no_answer":
      return phase === "incoming" ? `Missed call from ${name}.` : `${name} didn't answer.`;
    case "cancelled":
      return phase === "incoming" ? `Missed call from ${name}.` : null;
    case "failed":
      return `The call with ${name} was lost.`;
    case "hangup":
      return null;
  }
}

/** `05:23`, or `1:02:03` from one hour on. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** Chat message posted to the DM when a connected call ends. */
export function callSummaryText(media: CallMedia, durationMs: number): string {
  const label = media === "video" ? "📹 Video call ended" : "📞 Call ended";
  return `${label} • ${formatCallDuration(durationMs)}`;
}

/**
 * Exactly one side posts the summary: the caller, whoever hung up. Each side
 * ends a call once (`finish`), so the summary can't be posted twice, and a
 * simultaneous hang-up on both ends can't produce two messages.
 */
export function postsCallSummary(role: "caller" | "callee", connectedAt: number | null): boolean {
  return role === "caller" && connectedAt !== null;
}

export class CallManager {
  private deps: CallDeps | null = null;
  private session: Session | null = null;
  private readonly onPageHide = () => {
    if (this.session) this.hangUp();
  };

  /** Connects the manager to the signed-in chat session. */
  attach(deps: CallDeps): void {
    this.deps = deps;
    window.addEventListener("pagehide", this.onPageHide);
  }

  /** Ends any call (e.g. on sign-out) and stops listening. */
  detach(): void {
    if (this.session) this.hangUp();
    window.removeEventListener("pagehide", this.onPageHide);
    this.deps = null;
  }

  get busy(): boolean {
    return this.session !== null;
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  async startCall(channelId: string, peerId: string, media: CallMedia): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    if (this.session) {
      deps.notify("You're already in a call.");
      return;
    }
    const session = this.newSession({
      callId: ulid(),
      channelId,
      peerId,
      media,
      role: "caller",
      phase: "outgoing",
    });
    this.publish();

    if (!(await this.acquireMedia(session, media === "video"))) return;
    const pc = this.createPeerConnection(session);
    const local = this.localStream(session);
    session.audioSender = pc.addTransceiver(session.mic ?? "audio", {
      direction: "sendrecv",
      streams: [local],
    }).sender;
    session.videoSender = pc.addTransceiver(session.camera ?? "video", {
      direction: "sendrecv",
      streams: [local],
    }).sender;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!this.isCurrent(session)) return;
      this.signal(session, { signal: "offer", media, sdp: offer.sdp ?? "" });
    } catch {
      this.fail(session, "Couldn't start the call.");
      return;
    }
    this.later(session, RING_TIMEOUT_MS, () => {
      if (session.phase !== "outgoing") return;
      this.signal(session, { signal: "end", reason: "no_answer" });
      this.finish(session, endNotice("no_answer", deps.nameOf(session.peerId), "outgoing"));
    });
  }

  async accept(): Promise<void> {
    const session = this.session;
    if (session?.role !== "callee" || session.phase !== "incoming" || !session.offerSdp) return;
    stopRingtone();
    session.phase = "connecting";
    this.publish();

    if (!(await this.acquireMedia(session, session.media === "video"))) return;
    const pc = this.createPeerConnection(session);
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: session.offerSdp });
      const local = this.localStream(session);
      for (const transceiver of pc.getTransceivers()) {
        const kind = transceiver.receiver.track.kind;
        const track = kind === "audio" ? session.mic : session.camera;
        transceiver.direction = "sendrecv";
        await transceiver.sender.replaceTrack(track);
        transceiver.sender.setStreams?.(local);
        if (kind === "audio") session.audioSender = transceiver.sender;
        else session.videoSender = transceiver.sender;
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!this.isCurrent(session)) return;
      this.signal(session, { signal: "answer", sdp: answer.sdp ?? "" });
      await this.flushIce(session);
    } catch {
      this.fail(session, "Couldn't connect the call.");
    }
  }

  decline(): void {
    const session = this.session;
    if (session?.role !== "callee" || session.phase !== "incoming") return;
    this.signal(session, { signal: "decline", reason: "declined" });
    this.finish(session, null);
  }

  hangUp(): void {
    const session = this.session;
    if (!session) return;
    if (session.role === "callee" && session.phase === "incoming") {
      this.decline();
      return;
    }
    const reason = session.phase === "outgoing" ? "cancelled" : "hangup";
    this.signal(session, { signal: "end", reason });
    this.finish(session, null);
  }

  toggleMic(): void {
    const session = this.session;
    if (!session?.mic) return;
    session.mic.enabled = !session.mic.enabled;
    this.publish();
    this.sendMediaState(session);
  }

  async toggleCamera(): Promise<void> {
    const session = this.session;
    if (!session || session.phase === "incoming") return;
    if (session.camera) {
      session.camera.stop();
      session.camera = null;
      if (!session.screen) await session.videoSender?.replaceTrack(null);
    } else {
      try {
        const stream = await getUserMediaWithFallback({ audio: false, video: true });
        const [track] = stream.getVideoTracks();
        if (!this.isCurrent(session) || !track) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        session.camera = track;
        if (!session.screen) await session.videoSender?.replaceTrack(track);
      } catch (err) {
        this.deps?.notify(mediaErrorText(err, "camera"));
        return;
      }
    }
    this.publish();
    this.sendMediaState(session);
  }

  async toggleScreenShare(): Promise<void> {
    const session = this.session;
    if (!session || session.phase === "incoming") return;
    if (session.screen) {
      await this.stopScreenShare(session);
      return;
    }
    let track: MediaStreamTrack | undefined;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      track = stream.getVideoTracks()[0];
    } catch (err) {
      // Closing the browser's picker is not an error worth a toast.
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      this.deps?.notify(mediaErrorText(err, "screen"));
      return;
    }
    if (!track) return;
    if (!this.isCurrent(session)) {
      track.stop();
      return;
    }
    track.contentHint = "detail";
    // The browser's own "Stop sharing" button ends the track.
    track.addEventListener("ended", () => {
      if (session.screen === track) void this.stopScreenShare(session);
    });
    session.screen = track;
    await session.videoSender?.replaceTrack(track);
    this.publish();
    this.sendMediaState(session);
  }

  /**
   * Swaps the microphone or camera mid-call: captures the new device and
   * `replaceTrack`s it into the existing sender, so the connection is never
   * renegotiated. The choice is also saved as the preferred device. With the
   * camera off it is only saved, and used when the camera is turned back on.
   */
  async switchDevice(kind: "audio" | "video", deviceId: string): Promise<void> {
    const session = this.session;
    if (!session || session.phase === "incoming") return;
    const prefs = loadMediaPrefs();
    saveMediaPrefs(
      kind === "audio"
        ? { ...prefs, audioInputId: deviceId }
        : { ...prefs, videoInputId: deviceId },
    );

    const current = kind === "audio" ? session.mic : session.camera;
    if (!current) {
      this.publish();
      return;
    }
    if (current.getSettings().deviceId === deviceId) return;

    let track: MediaStreamTrack;
    try {
      track = await getDeviceTrack(kind, deviceId);
    } catch (err) {
      this.deps?.notify(mediaErrorText(err, kind === "audio" ? "microphone" : "camera"));
      return;
    }
    const stillCurrent = kind === "audio" ? session.mic : session.camera;
    if (!this.isCurrent(session) || stillCurrent !== current) {
      track.stop(); // the call ended or the input was toggled meanwhile
      return;
    }
    if (kind === "audio") {
      track.enabled = current.enabled; // keep muted calls muted
      await session.audioSender?.replaceTrack(track);
      session.mic = track;
    } else {
      // While sharing, the screen stays on the wire; the new camera returns after.
      if (!session.screen) await session.videoSender?.replaceTrack(track);
      session.camera = track;
    }
    current.stop();
    this.publish();
    this.sendMediaState(session);
  }

  // ---------------------------------------------------------------------------
  // Signaling from the server
  // ---------------------------------------------------------------------------

  handle(event: CallEvent): void {
    const deps = this.deps;
    if (!deps) return;
    const session = this.session;

    if (event.from === deps.myUserId()) {
      // Another tab of mine answered, declined or ended this call: stop ringing here.
      if (session?.callId === event.callId && session.phase === "incoming") {
        this.finish(session, null);
      }
      return;
    }

    if (event.type === "call.offer") {
      this.receiveOffer(event);
      return;
    }
    if (session?.callId !== event.callId) return; // stale or for another tab

    switch (event.type) {
      case "call.answer":
        void this.receiveAnswer(session, event.sdp);
        break;
      case "call.ice_candidate":
        void this.receiveIce(session, event.candidate);
        break;
      case "call.decline":
        this.finish(session, endNotice(event.reason, deps.nameOf(session.peerId), session.phase));
        break;
      case "call.end":
        this.finish(session, endNotice(event.reason, deps.nameOf(session.peerId), session.phase));
        break;
    }
  }

  private receiveOffer(event: Extract<CallEvent, { type: "call.offer" }>): void {
    const deps = this.deps;
    const current = this.session;
    if (!deps) return;
    if (current) {
      const me = deps.myUserId() ?? "";
      const glare =
        current.peerId === event.from && current.role === "caller" && current.phase === "outgoing";
      if (glare && me > event.from) {
        // Both called each other at once: the larger id yields and answers instead.
        this.signal(current, { signal: "end", reason: "cancelled" });
        this.finish(current, null);
      } else if (glare) {
        return; // the other side yields
      } else {
        deps.send({
          signal: "decline",
          reason: "busy",
          callId: event.callId,
          channelId: event.channelId,
          to: event.from,
        });
        return;
      }
    }
    const session = this.newSession({
      callId: event.callId,
      channelId: event.channelId,
      peerId: event.from,
      media: event.media,
      role: "callee",
      phase: "incoming",
    });
    session.offerSdp = event.sdp;
    startRingtone();
    this.publish();
    this.later(session, INCOMING_TIMEOUT_MS, () => {
      if (session.phase === "incoming") {
        this.finish(session, endNotice("no_answer", deps.nameOf(session.peerId), "incoming"));
      }
    });
  }

  private async receiveAnswer(session: Session, sdp: string): Promise<void> {
    if (session.role !== "caller" || session.phase !== "outgoing" || !session.pc) return;
    session.phase = "connecting";
    this.publish();
    try {
      await session.pc.setRemoteDescription({ type: "answer", sdp });
      await this.flushIce(session);
    } catch {
      this.fail(session, "Couldn't connect the call.");
    }
  }

  private async receiveIce(session: Session, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = session.pc;
    if (!pc?.remoteDescription) {
      session.pendingIce.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // A bad candidate only removes one path; the others may still connect.
    }
  }

  private async flushIce(session: Session): Promise<void> {
    const pending = session.pendingIce.splice(0);
    for (const candidate of pending) await this.receiveIce(session, candidate);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Whether `session` is still the live call (it may have ended during an await). */
  private isCurrent(session: Session): boolean {
    return this.session === session;
  }

  private newSession(
    fields: Pick<Session, "callId" | "channelId" | "peerId" | "media" | "role" | "phase">,
  ): Session {
    const session: Session = {
      ...fields,
      pc: null,
      control: null,
      offerSdp: null,
      pendingIce: [],
      mic: null,
      camera: null,
      screen: null,
      audioSender: null,
      videoSender: null,
      remote: new MediaStream(),
      preview: null,
      // Until the peer reports its state, assume it matches the kind of call.
      peer: { micOn: true, camOn: fields.media === "video", sharing: false },
      connectedAt: null,
      timers: new Set(),
      graceTimer: undefined,
    };
    this.session = session;
    return session;
  }

  /** Microphone (and camera for video calls); ends the call if access fails. */
  private async acquireMedia(session: Session, video: boolean): Promise<boolean> {
    try {
      const stream = await getUserMediaWithFallback({ audio: true, video });
      if (!this.isCurrent(session)) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      session.mic = stream.getAudioTracks()[0] ?? null;
      session.camera = stream.getVideoTracks()[0] ?? null;
      return true;
    } catch (err) {
      const what = video ? "camera or microphone" : "microphone";
      if (this.isCurrent(session)) {
        const reason = session.role === "callee" ? "failed" : "cancelled";
        if (session.role === "callee" || session.pc)
          this.signal(session, { signal: "end", reason });
        this.finish(session, mediaErrorText(err, what));
      }
      return false;
    }
  }

  private localStream(session: Session): MediaStream {
    const tracks = [session.mic, session.camera].filter((t): t is MediaStreamTrack => !!t);
    return new MediaStream(tracks);
  }

  private createPeerConnection(session: Session): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    session.pc = pc;

    pc.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate?.candidate) {
        this.signal(session, {
          signal: "ice_candidate",
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment,
          },
        });
      }
    });

    pc.addEventListener("track", ({ track }) => {
      if (!session.remote.getTracks().includes(track)) session.remote.addTrack(track);
      this.publish();
    });

    pc.addEventListener("connectionstatechange", () => {
      if (!this.isCurrent(session)) return;
      switch (pc.connectionState) {
        case "connected":
          clearTimeout(session.graceTimer);
          session.graceTimer = undefined;
          if (session.phase !== "connected") {
            session.phase = "connected";
            session.connectedAt ??= Date.now();
            this.publish();
          }
          break;
        case "disconnected":
          // Often a network blip that ICE recovers from on its own.
          clearTimeout(session.graceTimer);
          session.graceTimer = setTimeout(() => this.drop(session), DISCONNECT_GRACE_MS);
          break;
        case "failed":
          this.drop(session);
          break;
        default:
          break;
      }
    });

    // Negotiated with a fixed id on both sides, so no extra signaling is needed.
    const control = pc.createDataChannel("control", { negotiated: true, id: 0 });
    session.control = control;
    control.addEventListener("open", () => this.sendMediaState(session));
    control.addEventListener("message", ({ data }) => {
      const state = parsePeerState(data);
      if (state && this.isCurrent(session)) {
        session.peer = state;
        this.publish();
      }
    });
    return pc;
  }

  /** Connection lost for good: tell the peer (if it can still hear us) and clean up. */
  private drop(session: Session): void {
    if (!this.isCurrent(session)) return;
    this.signal(session, { signal: "end", reason: "failed" });
    this.finish(session, endNotice("failed", this.deps?.nameOf(session.peerId) ?? "", null));
  }

  private fail(session: Session, message: string): void {
    if (!this.isCurrent(session)) return;
    this.signal(session, { signal: "end", reason: "failed" });
    this.finish(session, message);
  }

  private async stopScreenShare(session: Session): Promise<void> {
    session.screen?.stop();
    session.screen = null;
    await session.videoSender?.replaceTrack(session.camera);
    if (!this.isCurrent(session)) return;
    this.publish();
    this.sendMediaState(session);
  }

  private sendMediaState(session: Session): void {
    if (session.control?.readyState !== "open") return;
    const state: PeerMediaState = {
      micOn: session.mic?.enabled ?? false,
      camOn: !!session.camera,
      sharing: !!session.screen,
    };
    session.control.send(JSON.stringify(state));
  }

  private signal(session: Session, payload: SignalPayload): void {
    this.deps?.send({
      ...payload,
      callId: session.callId,
      channelId: session.channelId,
      to: session.peerId,
    });
  }

  private later(session: Session, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (this.isCurrent(session)) fn();
    }, ms);
    session.timers.add(timer);
  }

  /** Releases everything the call holds and optionally explains why it ended. */
  private finish(session: Session, notice: string | null): void {
    if (!this.isCurrent(session)) return;
    this.session = null;
    if (postsCallSummary(session.role, session.connectedAt)) {
      const duration = Date.now() - (session.connectedAt ?? Date.now());
      this.deps?.postMessage(session.channelId, callSummaryText(session.media, duration));
    }
    stopRingtone();
    session.timers.forEach((t) => clearTimeout(t));
    clearTimeout(session.graceTimer);
    for (const track of [session.mic, session.camera, session.screen]) track?.stop();
    session.control?.close();
    session.pc?.close();
    useCall.setState({ call: null });
    if (notice) this.deps?.notify(notice);
  }

  private publish(): void {
    const s = this.session;
    if (!s) {
      useCall.setState({ call: null });
      return;
    }
    const video = s.screen ?? s.camera;
    if (s.preview?.track !== video) {
      s.preview = video ? { track: video, stream: new MediaStream([video]) } : null;
    }
    useCall.setState({
      call: {
        callId: s.callId,
        channelId: s.channelId,
        peerId: s.peerId,
        media: s.media,
        phase: s.phase,
        micOn: s.mic?.enabled ?? true,
        camOn: !!s.camera,
        sharing: !!s.screen,
        localVideo: s.preview?.stream ?? null,
        remoteStream: s.remote.getTracks().length > 0 ? s.remote : null,
        peer: { ...s.peer },
        connectedAt: s.connectedAt,
        micDeviceId: s.mic?.getSettings().deviceId ?? null,
        cameraDeviceId: s.camera?.getSettings().deviceId ?? null,
      },
    });
  }
}

/** Validates a media-state message from the peer's data channel. */
export function parsePeerState(data: unknown): PeerMediaState | null {
  if (typeof data !== "string" || data.length > 256) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const { micOn, camOn, sharing } = value as Record<string, unknown>;
    if (typeof micOn !== "boolean" || typeof camOn !== "boolean" || typeof sharing !== "boolean") {
      return null;
    }
    return { micOn, camOn, sharing };
  } catch {
    return null;
  }
}

export const calls = new CallManager();
