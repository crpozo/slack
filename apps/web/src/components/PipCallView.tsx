import type { CallMedia } from "@mindfultech/shared";
import { useEffect, useState, type ReactNode } from "react";
import { formatCallDuration } from "../lib/call";
import { Avatar } from "./Avatar";
import {
  CloseIcon,
  MaximizeIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  SparklesIcon,
  VideoIcon,
  VideoOffIcon,
} from "./icons";
import { ReconnectingOverlay } from "./Reconnecting";
import { StreamMedia } from "./StreamMedia";

/** What the popped-out call shows; the same view serves the browser's window and the desktop app's. */
export interface PipCallProps {
  name: string;
  phase: "outgoing" | "incoming" | "connecting" | "connected";
  media: CallMedia;
  connectedAt: number | null;
  micOn: boolean;
  camOn: boolean;
  peerMicOn: boolean;
  peerCamOn: boolean;
  peerSharing: boolean;
  /** AI call notes are on (both sides are being transcribed). */
  notesOn?: boolean;
  /** You're sharing your screen. */
  sharing?: boolean;
  /** Screen sharing can start from here (connected, and the call has a screen track). */
  canShare?: boolean;
  /** Starts or stops sharing your screen; without it there's no button. */
  onScreenShare?: () => void;
  /** Phase 34: the connection is being restored until then (epoch ms); `null` when connected. */
  reconnectingUntil?: number | null;
  /** The peer's camera and shared screen, when flowing. */
  camera: MediaStream | null;
  screen: MediaStream | null;
  onMic: () => void;
  onCamera: () => void;
  onHangUp: () => void;
  /** Back to the app (focuses it and closes the floating window). */
  onBack: () => void;
  /**
   * Phase 33: closes the floating window without bringing the app forward;
   * the call goes on in the app, and isn't popped out on its own again.
   */
  onClose?: () => void;
  /** Dragging the frameless desktop window by its header. */
  onDragStart?: () => void;
}

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? "" : formatCallDuration(now - since);
}

function Control({
  label,
  highlight = false,
  danger = false,
  onClick,
  children,
}: Readonly<{
  label: string;
  highlight?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}>) {
  let tone = "bg-white/15 text-white hover:bg-white/25";
  if (danger) tone = "bg-error text-white hover:bg-error/85";
  else if (highlight) tone = "bg-white text-[#0E0D12] hover:bg-white/85";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tone}`}
    >
      {children}
    </button>
  );
}

/**
 * The call, small: the peer's screen or camera (their avatar otherwise),
 * who and for how long, and the essential controls. Fills whatever window
 * it is rendered into.
 */
export function PipCallView(props: Readonly<PipCallProps>) {
  const { name, phase, connectedAt, camera, screen } = props;
  const elapsed = useElapsed(connectedAt);
  const connected = phase === "connected";
  const showScreen = props.peerSharing && !!screen;
  const showCamera = props.peerCamOn && !!camera;
  const reconnecting = props.reconnectingUntil ?? null;
  let status = elapsed;
  if (phase === "outgoing") status = "Calling…";
  else if (phase === "connecting") status = "Connecting…";
  if (reconnecting !== null) status = "Reconnecting…";
  else if (connected && !props.peerMicOn) status += " · Muted";

  return (
    <div
      className="flex h-full min-h-0 w-full select-none flex-col bg-[#0E0D12] text-white"
      data-pip-call
    >
      <div
        className="flex shrink-0 cursor-grab items-center gap-2 px-3 py-1.5 text-xs"
        onPointerDown={props.onDragStart}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            connected && reconnecting === null ? "bg-success" : "bg-warning"
          }`}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 truncate font-semibold">{name}</p>
        {props.notesOn && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/35 px-1.5 py-0.5 font-semibold"
            title="AI notes are on: this call is being transcribed."
          >
            <SparklesIcon aria-hidden="true" />
            <span className="sr-only">AI notes are on</span>
          </span>
        )}
        <p className="shrink-0 tabular-nums text-white/70" aria-live="polite">
          {status}
        </p>
        {props.onClose && (
          <button
            type="button"
            onClick={props.onClose}
            // Not a drag: the header moves the frameless desktop window.
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close window (the call continues in the app)"
            title="Close window (the call continues in the app)"
            className="-mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/70 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        {showScreen || showCamera ? (
          <StreamMedia
            kind="video"
            stream={showScreen ? screen : camera}
            muted
            label={showScreen ? `Screen from ${name}` : `Video from ${name}`}
            className={`h-full w-full ${showScreen ? "object-contain" : "object-cover"}`}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5">
            <Avatar name={name} size="md" />
            <p className="text-xs text-white/70">
              {connected && props.media === "video" ? "Camera is off" : "Voice call"}
            </p>
          </div>
        )}
        {reconnecting !== null && <ReconnectingOverlay deadline={reconnecting} compact />}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 px-3 py-2">
        <Control
          label={props.micOn ? "Mute microphone" : "Unmute microphone"}
          highlight={!props.micOn}
          onClick={props.onMic}
        >
          {props.micOn ? <MicIcon /> : <MicOffIcon />}
        </Control>
        <Control
          label={props.camOn ? "Turn camera off" : "Turn camera on"}
          highlight={!props.camOn}
          onClick={props.onCamera}
        >
          {props.camOn ? <VideoIcon /> : <VideoOffIcon />}
        </Control>
        {props.onScreenShare && props.canShare && (
          <Control
            label={props.sharing ? "Stop sharing screen" : "Share screen"}
            highlight={!!props.sharing}
            onClick={props.onScreenShare}
          >
            <ScreenShareIcon />
          </Control>
        )}
        <Control label="Back to the app" onClick={props.onBack}>
          <MaximizeIcon />
        </Control>
        <Control label="Hang up" danger onClick={props.onHangUp}>
          <PhoneOffIcon />
        </Control>
      </div>
    </div>
  );
}
