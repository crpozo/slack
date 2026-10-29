import {
  MAX_ICE_CANDIDATES_PER_SIGNAL,
  parseNotesPeerMessage,
  type CallEndReason,
  type CallEvent,
  type CallMedia,
  type ClientActionInput,
  type IceCandidate,
  type NotesPeerMessage,
  type SummarizeCallInput,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { create } from "zustand";
import {
  getDeviceTrack,
  getUserMediaWithFallback,
  loadMediaPrefs,
  mediaErrorText,
  saveMediaPrefs,
} from "./media";
import { CallRecorder, type CallRecording } from "./callRecorder";
import { VoiceClipRecorder, type NotesClip } from "./clipRecorder";
import { startRinging, stopRinging } from "./sounds";
import type { DistributiveOmit } from "./ws";

/**
 * 1:1 WebRTC calls in DMs. The WebSocket (API Gateway + the `call` Lambda)
 * only relays the JSON signaling; audio and video flow peer to peer.
 *
 * Both sides always negotiate three transceivers, audio, camera and screen,
 * in that order, so turning the camera on in a voice call or sharing the
 * screen is a `replaceTrack` on its own sender, never a renegotiation, and
 * camera and screen are sent at the same time. A negotiated data channel
 * carries each side's mic, camera and screen state so the other side can show
 * an avatar instead of black video.
 *
 * AI call notes (Phase 28) ride the same data channel: either side can switch
 * them on for both (the other side is told at once). From Phase 43 the
 * caller's app records each voice in short clips, each sent to OpenAI Whisper
 * as it ends (the audio is discarded once transcribed), and asks for the
 * notes when the call ends. Either side can also choose to keep the original
 * audio as a backup (the caller then records the mixed call, as in Phase 40).
 *
 * Network resilience (Phase 34): when a connected call's ICE goes
 * `disconnected` (Wi-Fi to cellular, a dead access point, a laptop lid) the
 * call doesn't hang up. It shows "Reconnecting…" and restarts ICE
 * (`restartIce` and a fresh offer, sent as a `renegotiate` signal): the
 * caller drives it, the callee also tries when its own network comes back
 * (`online`, or its socket reconnecting). Both may offer at once: the
 * "perfect negotiation" pattern settles it (the callee is polite and rolls
 * its offer back, the caller ignores the callee's). Unanswered offers are
 * re-sent (the other side's socket may be reconnecting) carrying every
 * candidate gathered so far, and a restart that didn't bring ICE back is
 * tried again with fresh candidates. 30 seconds after the drop, the call
 * ends. Tracks, the data channel and the AI notes all survive a restart.
 */

/**
 * Free public STUN only (two of Google's, in case one is slow): TURN relays
 * media through a server, which costs money. Without TURN, two peers both
 * behind symmetric NAT (typical on cellular) can't connect at all: the
 * `[call]` ICE trace below shows it as gathering only `host`/`srflx`
 * candidates and ending in `failed`.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/** ICE breadcrumbs in the console: the first thing to read when a call is slow to connect. */
const trace = (step: string, detail?: Record<string, unknown>) =>
  console.info("[call]", step, detail ?? "");

/** Which path the media took once connected: direct (`host`/`srflx`) or relayed (`relay`). */
async function traceSelectedPair(pc: RTCPeerConnection): Promise<void> {
  if (typeof pc.getStats !== "function") return;
  try {
    const stats = await pc.getStats();
    const pairs: RTCIceCandidatePairStats[] = [];
    stats.forEach((report: RTCStats) => {
      if (report.type === "candidate-pair") pairs.push(report as RTCIceCandidatePairStats);
    });
    const selected = pairs.find((p) => p.state === "succeeded" && p.nominated);
    if (!selected) return;
    const local = stats.get(selected.localCandidateId) as RTCIceCandidate | undefined;
    const remote = stats.get(selected.remoteCandidateId) as RTCIceCandidate | undefined;
    trace("selected candidate pair", {
      local: `${local?.type ?? "?"} ${local?.protocol ?? ""}`,
      remote: `${remote?.type ?? "?"} ${remote?.protocol ?? ""}`,
      rttMs:
        selected.currentRoundTripTime === undefined
          ? undefined
          : selected.currentRoundTripTime * 1000,
    });
  } catch (err) {
    trace("getStats failed", { error: String(err) });
  }
}
const RING_TIMEOUT_MS = 45_000;
const INCOMING_TIMEOUT_MS = 50_000;
/** A call still connecting that loses ICE gets this long before it fails. */
const DISCONNECT_GRACE_MS = 10_000;
/** Phase 34: how long a connected call tries to get its connection back before it ends. */
export const RECONNECT_TIMEOUT_MS = 30_000;
/** `disconnected` often heals by itself within a second or two: restart ICE only after this. */
export const RESTART_DELAY_MS = 2_000;
/** An unanswered restart offer is sent again after this, doubling up to `RESEND_MAX_MS`. */
export const RESEND_MS = 2_000;
const RESEND_MAX_MS = 8_000;
/** A restart that hasn't brought ICE back by then is made again, with fresh candidates. */
export const RESTART_RETRY_MS = 8_000;
/** Remote candidates kept for a description that hasn't arrived yet (a restart's new credentials). */
const MAX_PENDING_ICE = 200;
/**
 * Local candidates are held this long and sent together: one message per
 * candidate made each one its own Lambda invocation, and a gathering burst
 * hit the account's concurrency limit, so throttled candidates never arrived.
 */
const ICE_BATCH_MS = 150;

export type CallPhase = "outgoing" | "incoming" | "connecting" | "connected";

export interface PeerMediaState {
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
}

/** AI call notes as the call UI shows them. */
export interface CallNotesView {
  /** Switched on for the call (by either side). */
  on: boolean;
  /** Who switched them on or off last. */
  changedBy: string | null;
  /** Phase 43: "Guardar audio original como respaldo", chosen by either side (off by default). */
  keepAudio: boolean;
  /** Why this app (the caller's) can't record the call for notes; `null` when it can. */
  unavailable: string | null;
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
  /** Your camera, for the local preview tile. */
  localCamera: MediaStream | null;
  /** Your shared screen, for the local preview. */
  localScreen: MediaStream | null;
  /** The peer's audio and camera. */
  remoteStream: MediaStream | null;
  /** The peer's shared screen (its track exists even while they aren't sharing: see `peer.sharing`). */
  remoteScreen: MediaStream | null;
  /** Whether a screen transceiver was negotiated (an older peer may lack one). */
  canShare: boolean;
  peer: PeerMediaState;
  connectedAt: number | null;
  /** Devices currently captured (`null` while that input is off). */
  micDeviceId: string | null;
  cameraDeviceId: string | null;
  notes: CallNotesView;
  /**
   * Phase 34: the connection dropped and is being restored: since when, and
   * when the call ends if it isn't (both epoch ms). `null` while connected.
   */
  reconnecting: { since: number; deadline: number } | null;
}

export const useCall = create<{ call: CallView | null }>(() => ({ call: null }));

/** DM call signals (the channel-call room ops are `GroupCallManager`'s). */
type CallInput = Exclude<
  Extract<ClientActionInput, { action: "call" }>,
  { signal: "join" | "leave" | "rooms" }
>;
type SignalPayload = DistributiveOmit<CallInput, "action" | "callId" | "channelId" | "to">;
/**
 * Sends a signal over the socket. `key`: while the socket is offline, a
 * queued signal with the same key is replaced (only the newest restart
 * offer goes out when it's back).
 */
export type SendCallSignal = (payload: DistributiveOmit<CallInput, "action">, key?: string) => void;

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
  /** Local candidates waiting to go out in the next `ice_candidates` batch. */
  outgoingIce: IceCandidate[];
  mic: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  audioSender: RTCRtpSender | null;
  videoSender: RTCRtpSender | null;
  screenSender: RTCRtpSender | null;
  remote: MediaStream;
  remoteScreen: MediaStream;
  /** Local preview streams, rebuilt only when the sent track changes. */
  cameraPreview: { track: MediaStreamTrack; stream: MediaStream } | null;
  screenPreview: { track: MediaStreamTrack; stream: MediaStream } | null;
  peer: PeerMediaState;
  connectedAt: number | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  notes: NotesSession;
  /** Phase 34: when the connection dropped (epoch ms), while it's being restored. */
  reconnectingSince: number | null;
  /** The restore's timers (restart, re-send, the 30-second limit), cleared once it's back. */
  reconnectTimers: Set<ReturnType<typeof setTimeout>>;
  /** The next scheduled ICE restart. */
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** My ICE restarts so far: the number of my latest restart offer. */
  restarts: number;
  /** The newest restart offer applied from the peer. */
  peerRestart: number;
  /** Creating an offer right now (perfect negotiation: a crossing offer is a collision). */
  makingOffer: boolean;
}

interface NotesSession {
  on: boolean;
  /** Notes were on at some point, so the call's clips are worth summarizing. */
  used: boolean;
  /** When `on` last changed (epoch ms): the later of two crossing toggles wins. */
  changedAt: number;
  changedBy: string | null;
  /** Phase 43: keep the original audio with the notes; the later of two crossing choices wins. */
  keepAudio: boolean;
  keepChangedAt: number;
  /** Phase 43: the caller's clips of each voice for Whisper (`null` elsewhere). */
  clips: { mine: VoiceClipRecorder; theirs: VoiceClipRecorder } | null;
  unavailable: string | null;
  /** Phase 40: the caller's mixed recording, only while the original audio is to be kept. */
  recorder: CallRecorder | null;
}

export interface CallDeps {
  send: SendCallSignal;
  /** Posts a regular chat message (used for the "call ended" summary). */
  postMessage: (channelId: string, text: string) => void;
  myUserId: () => string | null;
  nameOf: (userId: string) => string;
  notify: (text: string) => void;
  /**
   * Asks for a finished call's AI notes (caller only, see `postsCallSummary`)
   * once `ready` (the last clips handed over) and every clip is transcribed.
   */
  submitNotes: (input: SummarizeCallInput, ready: Promise<void>) => void;
  /** Phase 43: sends one clip of one voice (`speaker`) to be transcribed. */
  uploadNotesClip?: (
    call: { callId: string; channelId: string },
    clip: NotesClip & { speaker: string },
  ) => void;
  /** Phase 40: uploads the call's recording and attaches it to its notes card, once it's ready. */
  submitRecording?: (
    call: { callId: string; channelId: string },
    recording: Promise<CallRecording | null>,
  ) => void;
  /** Phase 36: in a channel call already (one call at a time). */
  busyElsewhere?: () => boolean;
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

/** The screen is the second video m-line: audio, camera, screen (see `startCall` / `accept`). */
function isScreenTransceiver(pc: RTCPeerConnection, transceiver: RTCRtpTransceiver): boolean {
  const videos = pc.getTransceivers().filter((t) => t.receiver.track.kind === "video");
  return videos.indexOf(transceiver) === 1;
}

export class CallManager {
  private deps: CallDeps | null = null;
  private session: Session | null = null;
  private readonly onPageHide = () => {
    if (this.session) this.hangUp();
  };
  /** This device's network is back: a call being restored restarts ICE now. */
  private readonly onOnline = () => this.networkBack();

  /** Connects the manager to the signed-in chat session. */
  attach(deps: CallDeps): void {
    this.deps = deps;
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("online", this.onOnline);
  }

  /** Ends any call (e.g. on sign-out) and stops listening. */
  detach(): void {
    if (this.session) this.hangUp();
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("online", this.onOnline);
    this.deps = null;
  }

  /**
   * The signaling socket reconnected (Phase 34): signals sent to us while it
   * was down are lost, so a call being restored restarts (or re-sends) now
   * rather than at its next timer.
   */
  signalingReconnected(): void {
    this.networkBack();
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
    if (this.session || deps.busyElsewhere?.()) {
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
    session.screenSender = pc.addTransceiver("video", {
      direction: "sendrecv",
      streams: [local],
    }).sender;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!this.isCurrent(session)) return;
      this.signal(session, { signal: "offer", media, sdp: offer.sdp ?? "" });
      startRinging("outgoing");
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
    stopRinging();
    session.phase = "connecting";
    this.publish();

    if (!(await this.acquireMedia(session, session.media === "video"))) return;
    const pc = this.createPeerConnection(session);
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: session.offerSdp });
      const local = this.localStream(session);
      // The offer lists audio, camera, then screen; map them back in that order.
      let videos = 0;
      const swaps: Promise<void>[] = [];
      for (const transceiver of pc.getTransceivers()) {
        const kind = transceiver.receiver.track.kind;
        transceiver.direction = "sendrecv";
        transceiver.sender.setStreams?.(local);
        if (kind === "audio") {
          swaps.push(transceiver.sender.replaceTrack(session.mic));
          session.audioSender = transceiver.sender;
        } else if (videos++ === 0) {
          swaps.push(transceiver.sender.replaceTrack(session.camera));
          session.videoSender = transceiver.sender;
        } else {
          session.screenSender = transceiver.sender;
        }
      }
      await Promise.all(swaps);
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
    this.syncRecorder(session); // muted means not recorded for notes, too
    this.publish();
    this.sendMediaState(session);
  }

  /**
   * Switches AI notes on or off for both sides. The other side is told over
   * the data channel (and shown who did it), so nobody is transcribed without
   * knowing.
   */
  async toggleNotes(): Promise<void> {
    const session = this.session;
    const me = this.deps?.myUserId();
    if (!session || !me || session.phase !== "connected") return;
    if (session.control?.readyState !== "open") {
      this.deps?.notify("AI notes need the call to be fully connected.");
      return;
    }
    const on = !session.notes.on;
    const at = Date.now();
    this.sendNotesMessage(session, { type: "notes", on, at });
    await this.applyNotes(session, on, at, me);
  }

  /**
   * Phase 43: "Guardar audio original como respaldo", for both sides (the
   * other side is told). Off by default: the audio is then only ever sent to
   * Whisper, and discarded.
   */
  toggleKeepAudio(): void {
    const session = this.session;
    const me = this.deps?.myUserId();
    if (!session || !me || session.phase !== "connected") return;
    if (session.control?.readyState !== "open") {
      this.deps?.notify("Saving the audio needs the call to be fully connected.");
      return;
    }
    const keep = !session.notes.keepAudio;
    const at = Date.now();
    this.sendNotesMessage(session, { type: "backup", keep, at });
    this.applyKeepAudio(session, keep, at, me);
  }

  async toggleCamera(): Promise<void> {
    const session = this.session;
    if (!session || session.phase === "incoming") return;
    if (session.camera) {
      session.camera.stop();
      session.camera = null;
      await session.videoSender?.replaceTrack(null);
    } else {
      try {
        const stream = await getUserMediaWithFallback({ audio: false, video: true });
        const [track] = stream.getVideoTracks();
        if (!this.isCurrent(session) || !track) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        session.camera = track;
        await session.videoSender?.replaceTrack(track);
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
    if (!session.screenSender) {
      this.deps?.notify("Screen sharing isn't available in this call.");
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
    await session.screenSender.replaceTrack(track);
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
      this.syncRecorder(session); // record the new microphone
    } else {
      await session.videoSender?.replaceTrack(track);
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
      case "call.renegotiate":
        void this.receiveRenegotiate(session, event);
        break;
    }
  }

  private receiveOffer(event: Extract<CallEvent, { type: "call.offer" }>): void {
    const deps = this.deps;
    const current = this.session;
    if (!deps) return;
    if (!current && deps.busyElsewhere?.()) {
      // In a channel call: the DM caller hears "on another call".
      deps.send({
        signal: "decline",
        reason: "busy",
        callId: event.callId,
        channelId: event.channelId,
        to: event.from,
      });
      return;
    }
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
    startRinging("incoming");
    this.publish();
    this.later(session, INCOMING_TIMEOUT_MS, () => {
      if (session.phase === "incoming") {
        this.finish(session, endNotice("no_answer", deps.nameOf(session.peerId), "incoming"));
      }
    });
  }

  private async receiveAnswer(session: Session, sdp: string): Promise<void> {
    if (session.role !== "caller" || session.phase !== "outgoing" || !session.pc) return;
    stopRinging();
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
      // During an ICE restart it may belong to the peer's new credentials,
      // whose description is still on its way: keep it for then.
      if (
        session.reconnectingSince !== null &&
        candidate.usernameFragment &&
        session.pendingIce.length < MAX_PENDING_ICE
      ) {
        session.pendingIce.push(candidate);
      }
    }
  }

  private async flushIce(session: Session): Promise<void> {
    const pending = session.pendingIce.splice(0);
    await Promise.all(pending.map((candidate) => this.receiveIce(session, candidate)));
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
      outgoingIce: [],
      mic: null,
      camera: null,
      screen: null,
      audioSender: null,
      videoSender: null,
      screenSender: null,
      remote: new MediaStream(),
      remoteScreen: new MediaStream(),
      cameraPreview: null,
      screenPreview: null,
      // Until the peer reports its state, assume it matches the kind of call.
      peer: { micOn: true, camOn: fields.media === "video", sharing: false },
      connectedAt: null,
      timers: new Set(),
      graceTimer: undefined,
      reconnectingSince: null,
      reconnectTimers: new Set(),
      restartTimer: undefined,
      restarts: 0,
      peerRestart: 0,
      makingOffer: false,
      notes: {
        on: false,
        used: false,
        changedAt: 0,
        changedBy: null,
        keepAudio: false,
        keepChangedAt: 0,
        clips: null,
        unavailable: null,
        recorder: null,
      },
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
    const startedAt = Date.now();
    const sinceStart = () => ({ callId: session.callId, afterMs: Date.now() - startedAt });
    trace("peer connection created", { ...sinceStart(), iceServers: ICE_SERVERS.length });

    pc.addEventListener("icegatheringstatechange", () =>
      trace(`ice gathering ${pc.iceGatheringState}`, sinceStart()),
    );
    pc.addEventListener("iceconnectionstatechange", () => {
      trace(`ice connection ${pc.iceConnectionState}`, sinceStart());
      this.onIceState(session, pc.iceConnectionState);
    });
    pc.addEventListener("icecandidateerror", (e) => {
      const { url, errorCode, errorText } = e as RTCPeerConnectionIceErrorEvent;
      trace("ice candidate error", { ...sinceStart(), url, errorCode, errorText });
    });

    pc.addEventListener("icecandidate", ({ candidate }) => {
      if (!candidate?.candidate) {
        // Gathering is complete: nothing more to wait for.
        this.sendQueuedIce(session);
        return;
      }
      trace("local candidate", { type: candidate.type, protocol: candidate.protocol });
      if (session.outgoingIce.length === 0) {
        this.later(session, ICE_BATCH_MS, () => this.sendQueuedIce(session));
      }
      session.outgoingIce.push({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      });
      if (session.outgoingIce.length >= MAX_ICE_CANDIDATES_PER_SIGNAL) this.sendQueuedIce(session);
    });

    pc.addEventListener("track", ({ track, transceiver }) => {
      // Fires inside setRemoteDescription on the callee, before the senders are mapped,
      // so the screen is told apart by its position, not by a stored reference.
      const target = isScreenTransceiver(pc, transceiver) ? session.remoteScreen : session.remote;
      if (!target.getTracks().includes(track)) target.addTrack(track);
      this.syncRecorder(session); // the other voice joins the recording
      this.publish();
    });

    pc.addEventListener("connectionstatechange", () => {
      trace(`connection ${pc.connectionState}`, sinceStart());
      if (!this.isCurrent(session)) return;
      switch (pc.connectionState) {
        case "connected":
          void traceSelectedPair(pc);
          clearTimeout(session.graceTimer);
          session.graceTimer = undefined;
          if (session.phase !== "connected") {
            session.phase = "connected";
            session.connectedAt ??= Date.now();
            this.publish();
          }
          this.reconnected(session);
          break;
        case "disconnected":
          // Once connected, the ICE state drives the restore (`onIceState`).
          if (session.connectedAt !== null) break;
          // Still connecting: often a blip that ICE recovers from on its own.
          clearTimeout(session.graceTimer);
          session.graceTimer = setTimeout(() => this.drop(session), DISCONNECT_GRACE_MS);
          break;
        case "failed":
          if (session.connectedAt === null) this.drop(session);
          else this.beginReconnect(session, 0);
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
      if (!this.isCurrent(session)) return;
      const notes = parseNotesPeerMessage(data);
      if (notes) {
        this.receiveNotesMessage(session, notes);
        return;
      }
      const state = parsePeerState(data);
      if (state) {
        session.peer = state;
        this.publish();
      }
    });
    return pc;
  }

  /** Connection lost for good: tell the peer (if it can still hear us) and clean up. */
  private drop(session: Session, notice?: string): void {
    if (!this.isCurrent(session)) return;
    this.signal(session, { signal: "end", reason: "failed" });
    this.finish(
      session,
      notice ?? endNotice("failed", this.deps?.nameOf(session.peerId) ?? "", null),
    );
  }

  // ---------------------------------------------------------------------------
  // Reconnecting (Phase 34)
  // ---------------------------------------------------------------------------

  /** ICE state changes of a call: a connected call that loses its network is restored. */
  private onIceState(session: Session, state: RTCIceConnectionState): void {
    if (!this.isCurrent(session)) return;
    switch (state) {
      case "connected":
      case "completed":
        this.reconnected(session);
        break;
      case "disconnected":
        // Still connecting: the connection-state grace period handles it.
        if (session.connectedAt !== null) this.beginReconnect(session, RESTART_DELAY_MS);
        break;
      case "failed":
        if (session.connectedAt !== null) this.beginReconnect(session, 0);
        break;
      default:
        break;
    }
  }

  /**
   * The connection dropped: "Reconnecting…" from now, the call ends in
   * `RECONNECT_TIMEOUT_MS` unless it's back, and the caller restarts ICE
   * after `delay` (sooner if it gets worse).
   */
  private beginReconnect(session: Session, delay: number): void {
    if (session.reconnectingSince === null) {
      session.reconnectingSince = Date.now();
      trace("reconnecting", { callId: session.callId, role: session.role });
      this.reconnectLater(session, RECONNECT_TIMEOUT_MS, () => {
        trace("reconnect timed out", { callId: session.callId, restarts: session.restarts });
        const name = this.deps?.nameOf(session.peerId) ?? "";
        this.drop(session, `The connection to ${name} couldn't be restored, so the call ended.`);
      });
      this.publish();
    }
    // The caller drives restarts; the callee waits for its offer (or its own network news).
    if (session.role === "caller") this.scheduleRestart(session, delay);
  }

  /** The connection is back: everything about restoring it stops. */
  private reconnected(session: Session): void {
    if (session.reconnectingSince === null) return;
    trace("reconnected", {
      callId: session.callId,
      afterMs: Date.now() - session.reconnectingSince,
      restarts: session.restarts,
    });
    session.reconnectingSince = null;
    this.clearReconnect(session);
    this.publish();
    this.sendMediaState(session);
  }

  private clearReconnect(session: Session): void {
    session.reconnectTimers.forEach((t) => clearTimeout(t));
    session.reconnectTimers.clear();
    clearTimeout(session.restartTimer);
    session.restartTimer = undefined;
  }

  /** `later`, but cancelled as soon as the connection is back. */
  private reconnectLater(session: Session, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      session.reconnectTimers.delete(timer);
      if (this.isCurrent(session) && session.reconnectingSince !== null) fn();
    }, ms);
    session.reconnectTimers.add(timer);
  }

  /** (Re)schedules the next ICE restart (one at a time). */
  private scheduleRestart(session: Session, delay: number): void {
    clearTimeout(session.restartTimer);
    session.restartTimer = setTimeout(() => {
      session.restartTimer = undefined;
      void this.restartIce(session);
    }, delay);
  }

  /** The network came back here (or the socket did): restore now instead of at the next timer. */
  private networkBack(): void {
    const session = this.session;
    if (!session || session.reconnectingSince === null || !session.pc) return;
    trace("network back while reconnecting", { callId: session.callId, role: session.role });
    // An offer of ours still unanswered is sent again (the peer may have missed it).
    if (session.pc.signalingState === "have-local-offer") {
      this.sendRestartOffer(session, session.restarts);
    } else {
      this.scheduleRestart(session, 0);
    }
  }

  /**
   * An ICE restart: new credentials, fresh candidates, a new offer for the
   * peer. An offer of ours left unanswered is rolled back first; the peer's
   * offer in progress is left to finish. The caller schedules another
   * restart in case this one doesn't bring the connection back.
   */
  private async restartIce(session: Session): Promise<void> {
    const pc = session.pc;
    if (!this.isCurrent(session) || session.reconnectingSince === null || !pc) return;
    // The caller keeps trying; the callee's restarts are one-offs on news of its network.
    if (session.role === "caller") this.scheduleRestart(session, RESTART_RETRY_MS);
    try {
      if (pc.signalingState === "have-local-offer") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      if (pc.signalingState !== "stable") return; // the peer's offer is being answered
      session.makingOffer = true;
      const restart = session.restarts + 1;
      pc.restartIce?.();
      const offer = await pc.createOffer({ iceRestart: true });
      // The peer's offer arrived meanwhile and won (or the call ended).
      if (!this.isCurrent(session) || pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      session.restarts = restart;
      trace("ice restart", { callId: session.callId, restart });
      this.sendRestartOffer(session, restart);
    } catch (err) {
      trace("ice restart failed", { callId: session.callId, error: String(err) });
    } finally {
      session.makingOffer = false;
    }
  }

  /**
   * Sends restart offer `restart` (its SDP as it stands: every candidate
   * gathered so far), then again after `wait` until it's answered or
   * superseded. The peer's socket may have been down the first time.
   */
  private sendRestartOffer(session: Session, restart: number, wait = RESEND_MS): void {
    const pc = session.pc;
    if (!pc || !this.isCurrent(session) || session.reconnectingSince === null) return;
    if (pc.signalingState !== "have-local-offer" || session.restarts !== restart) return;
    this.signal(
      session,
      { signal: "renegotiate", kind: "offer", sdp: pc.localDescription?.sdp ?? "", restart },
      `call-restart-offer:${session.callId}`,
    );
    this.reconnectLater(session, wait, () =>
      this.sendRestartOffer(session, restart, Math.min(wait * 2, RESEND_MAX_MS)),
    );
  }

  /**
   * The peer's restart offer (answered: by the caller unless its own offer
   * is in flight, by the callee always, rolling its own back) or the
   * answer to ours.
   */
  private async receiveRenegotiate(
    session: Session,
    event: Extract<CallEvent, { type: "call.renegotiate" }>,
  ): Promise<void> {
    const pc = session.pc;
    if (!pc?.remoteDescription) return; // not connected yet: nothing to restart
    if (event.kind === "answer") {
      // Stale, superseded or a re-sent answer we already applied.
      if (pc.signalingState !== "have-local-offer" || event.restart !== session.restarts) return;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
        trace("ice restart answered", { callId: session.callId, restart: event.restart });
        await this.flushIce(session);
      } catch (err) {
        trace("ice restart answer failed", { callId: session.callId, error: String(err) });
      }
      this.checkRestored(session, pc);
      return;
    }

    if (event.restart < session.peerRestart) return; // older than one already applied
    const polite = session.role === "callee";
    const collision = session.makingOffer || pc.signalingState !== "stable";
    if (collision && !polite) {
      trace("ice restart collision: keeping ours", { callId: session.callId });
      return;
    }
    try {
      if (pc.signalingState === "have-local-offer") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp: event.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (err) {
      trace("ice restart offer failed", { callId: session.callId, error: String(err) });
      return;
    }
    if (!this.isCurrent(session)) return;
    session.peerRestart = event.restart;
    trace("ice restart offer answered", { callId: session.callId, restart: event.restart });
    this.signal(
      session,
      {
        signal: "renegotiate",
        kind: "answer",
        sdp: pc.localDescription?.sdp ?? "",
        restart: event.restart,
      },
      `call-restart-answer:${session.callId}`,
    );
    await this.flushIce(session);
    this.checkRestored(session, pc);
  }

  /**
   * After a restart is applied: when a path still works, the browser keeps
   * ICE `connected` through the restart and fires no state change, so the
   * state is read here rather than waited for.
   */
  private checkRestored(session: Session, pc: RTCPeerConnection): void {
    if (!this.isCurrent(session) || session.reconnectingSince === null) return;
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      this.reconnected(session);
    }
  }

  private fail(session: Session, message: string): void {
    if (!this.isCurrent(session)) return;
    this.signal(session, { signal: "end", reason: "failed" });
    this.finish(session, message);
  }

  private async stopScreenShare(session: Session): Promise<void> {
    session.screen?.stop();
    session.screen = null;
    await session.screenSender?.replaceTrack(null);
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

  /** Sends the buffered local candidates in one `ice_candidates` signal. */
  private sendQueuedIce(session: Session): void {
    if (!this.isCurrent(session) || session.outgoingIce.length === 0) return;
    const candidates = session.outgoingIce;
    session.outgoingIce = [];
    this.signal(session, { signal: "ice_candidates", candidates });
  }

  private signal(session: Session, payload: SignalPayload, key?: string): void {
    this.deps?.send(
      { ...payload, callId: session.callId, channelId: session.channelId, to: session.peerId },
      key,
    );
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
    const { recorder, clips } = session.notes;
    session.notes.recorder = null;
    session.notes.clips = null;
    let submitted = false;
    if (postsCallSummary(session.role, session.connectedAt)) {
      const endedAt = Date.now();
      const startedAt = session.connectedAt ?? endedAt;
      this.deps?.postMessage(
        session.channelId,
        callSummaryText(session.media, endedAt - startedAt),
      );
      submitted = this.submitNotes(session, clips, startedAt, endedAt);
    }
    if (!submitted) {
      clips?.mine.dispose();
      clips?.theirs.dispose();
    }
    // The original audio goes with the notes it belongs to, if someone asked to keep it.
    if (recorder && submitted && session.notes.keepAudio && this.deps?.submitRecording) {
      this.deps.submitRecording(
        { callId: session.callId, channelId: session.channelId },
        recorder.stop(),
      );
    } else {
      recorder?.dispose();
    }
    stopRinging();
    session.timers.forEach((t) => clearTimeout(t));
    clearTimeout(session.graceTimer);
    this.clearReconnect(session);
    for (const track of [session.mic, session.camera, session.screen]) track?.stop();
    session.control?.close();
    session.pc?.close();
    useCall.setState({ call: null });
    if (notice) this.deps?.notify(notice);
  }

  // ---------------------------------------------------------------------------
  // AI call notes
  // ---------------------------------------------------------------------------

  private sendNotesMessage(session: Session, message: NotesPeerMessage): void {
    if (session.control?.readyState !== "open") return;
    try {
      session.control.send(JSON.stringify(message));
    } catch {
      // The channel closed meanwhile: the call is ending.
    }
  }

  private receiveNotesMessage(session: Session, message: NotesPeerMessage): void {
    if (message.type === "notes") {
      void this.applyNotes(session, message.on, message.at, session.peerId);
    } else if (message.type === "backup") {
      this.applyKeepAudio(session, message.keep, message.at, session.peerId);
    }
    // `transcript`: phrases from an app before Phase 43. The caller's clips
    // already hold both voices, so they're left out.
  }

  /** Turns notes on or off for this call, whoever asked (`by`). */
  private async applyNotes(session: Session, on: boolean, at: number, by: string): Promise<void> {
    const notes = session.notes;
    if (at < notes.changedAt) return; // an older toggle crossing a newer one
    notes.changedAt = at;
    if (notes.on === on) return;
    notes.on = on;
    notes.changedBy = by;
    if (on) notes.used = true;

    const deps = this.deps;
    const mine = by === deps?.myUserId();
    const name = deps?.nameOf(by) ?? "";
    if (on) {
      const what = `The call's audio is sent to OpenAI for transcription and then discarded${
        notes.keepAudio ? " (a backup of the original audio is saved)" : ""
      }; notes are posted when it ends.`;
      deps?.notify(mine ? `✨ AI notes are on. ${what}` : `✨ ${name} turned on AI notes. ${what}`);
    } else {
      deps?.notify(mine ? "AI notes are off." : `${name} turned off AI notes.`);
    }

    // Phase 43: the caller (who asks for the notes) records each voice for Whisper.
    if (on && session.role === "caller" && !notes.clips && !notes.unavailable) {
      const me = deps?.myUserId();
      const mineClips = me ? VoiceClipRecorder.create((c) => this.clipReady(session, me, c)) : null;
      const theirs = VoiceClipRecorder.create((c) => this.clipReady(session, session.peerId, c));
      if (mineClips && theirs) {
        notes.clips = { mine: mineClips, theirs };
      } else {
        mineClips?.dispose();
        theirs?.dispose();
        notes.unavailable = "This browser can't record the call, so there won't be AI notes.";
        deps?.notify(`✨ ${notes.unavailable}`);
      }
    }
    this.ensureBackup(session);
    this.syncRecorder(session);
    this.publish();
  }

  /** Phase 43: keeps the original audio or not, whoever chose (`by`). */
  private applyKeepAudio(session: Session, keep: boolean, at: number, by: string): void {
    const notes = session.notes;
    if (at < notes.keepChangedAt) return; // an older choice crossing a newer one
    notes.keepChangedAt = at;
    if (notes.keepAudio === keep) return;
    notes.keepAudio = keep;
    const deps = this.deps;
    const mine = by === deps?.myUserId();
    const name = deps?.nameOf(by) ?? "";
    if (keep) {
      deps?.notify(
        mine
          ? "The original audio will be saved with the notes."
          : `${name} chose to save the original audio with the notes.`,
      );
    } else {
      deps?.notify(
        mine
          ? "The original audio won't be saved."
          : `${name} chose not to save the original audio.`,
      );
      // What was recorded for the backup is dropped at once.
      notes.recorder?.dispose();
      notes.recorder = null;
    }
    this.ensureBackup(session);
    this.syncRecorder(session);
    this.publish();
  }

  /** The caller records the mixed call (Phase 40) only while the original audio is to be kept. */
  private ensureBackup(session: Session): void {
    const notes = session.notes;
    if (!notes.on || !notes.keepAudio || session.role !== "caller" || notes.recorder) return;
    notes.recorder = CallRecorder.create();
    if (!notes.recorder) {
      this.deps?.notify("This browser can't record the call: the original audio won't be saved.");
    }
  }

  /**
   * Records while notes are on and the call is connected: each voice in clips
   * (yours not while muted) and, if it's to be kept, the mixed call.
   */
  private syncRecorder(session: Session): void {
    const { recorder, clips, on, keepAudio } = session.notes;
    const live = on && session.phase === "connected";
    if (clips) {
      clips.mine.setTrack(session.mic);
      clips.theirs.setTrack(session.remote.getAudioTracks()[0]);
      clips.mine.setRecording(live && !!session.mic?.enabled);
      clips.theirs.setRecording(live);
    }
    if (recorder) {
      recorder.setSources([session.mic, ...session.remote.getAudioTracks()]);
      recorder.setRecording(live && keepAudio);
    }
  }

  /** A clip of one voice ended: off to Whisper (even after the call, for its last clips). */
  private clipReady(session: Session, speaker: string, clip: NotesClip): void {
    this.deps?.uploadNotesClip?.(
      { callId: session.callId, channelId: session.channelId },
      { ...clip, speaker },
    );
  }

  /**
   * On hang-up, the caller asks for the notes (if they were ever on) once the
   * last clips are handed over.
   */
  private submitNotes(
    session: Session,
    clips: NotesSession["clips"],
    startedAt: number,
    endedAt: number,
  ): boolean {
    const { notes } = session;
    if (!notes.used) return false;
    if (!clips) {
      this.deps?.notify("✨ The call wasn't recorded, so there are no AI notes for it.");
      return false;
    }
    const ready = Promise.all([clips.mine.stop(), clips.theirs.stop()]).then(() => {});
    this.deps?.submitNotes(
      {
        callId: session.callId,
        channelId: session.channelId,
        startedAt,
        endedAt,
        source: "whisper",
        keepAudio: notes.keepAudio,
      },
      ready,
    );
    return true;
  }

  private publish(): void {
    const s = this.session;
    if (!s) {
      useCall.setState({ call: null });
      return;
    }
    if (s.cameraPreview?.track !== s.camera) {
      s.cameraPreview = s.camera ? { track: s.camera, stream: new MediaStream([s.camera]) } : null;
    }
    if (s.screenPreview?.track !== s.screen) {
      s.screenPreview = s.screen ? { track: s.screen, stream: new MediaStream([s.screen]) } : null;
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
        localCamera: s.cameraPreview?.stream ?? null,
        localScreen: s.screenPreview?.stream ?? null,
        remoteStream: s.remote.getTracks().length > 0 ? s.remote : null,
        remoteScreen: s.remoteScreen.getTracks().length > 0 ? s.remoteScreen : null,
        canShare: s.screenSender !== null,
        peer: { ...s.peer },
        connectedAt: s.connectedAt,
        micDeviceId: s.mic?.getSettings().deviceId ?? null,
        cameraDeviceId: s.camera?.getSettings().deviceId ?? null,
        notes: {
          on: s.notes.on,
          changedBy: s.notes.changedBy,
          keepAudio: s.notes.keepAudio,
          unavailable: s.notes.unavailable,
        },
        reconnecting:
          s.reconnectingSince === null
            ? null
            : { since: s.reconnectingSince, deadline: s.reconnectingSince + RECONNECT_TIMEOUT_MS },
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
