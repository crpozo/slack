import { useEffect, useRef, useState, type ReactNode } from "react";
import { calls, useCall, type CallView } from "../lib/call";
import { supportsScreenShare } from "../lib/media";
import { useNameOf } from "../store";
import { Avatar } from "./Avatar";
import {
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  VideoIcon,
  VideoOffIcon,
} from "./icons";

/** `<video>`/`<audio>` bound to a MediaStream (React can't set `srcObject` as a prop). */
function StreamMedia({
  stream,
  kind,
  muted = false,
  className,
  label,
}: Readonly<{
  stream: MediaStream | null;
  kind: "video" | "audio";
  muted?: boolean;
  className?: string;
  label?: string;
}>) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {}); // autoplay may need a gesture; we had one
  }, [stream]);
  if (kind === "audio") return <audio ref={ref} autoPlay className="hidden" />;
  return (
    <video ref={ref} autoPlay playsInline muted={muted} className={className} aria-label={label}>
      <track kind="captions" />
    </video>
  );
}

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return "";
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function statusText(call: CallView, elapsed: string): string {
  switch (call.phase) {
    case "outgoing":
      return "Calling…";
    case "connecting":
      return "Connecting…";
    case "connected":
      return elapsed;
    case "incoming":
      return call.media === "video" ? "Incoming video call…" : "Incoming voice call…";
  }
}

function ControlButton({
  label,
  highlight = false,
  danger = false,
  onClick,
  children,
}: Readonly<{
  /** Says what a click does ("Mute microphone"), so it changes with the state. */
  label: string;
  /** Inverted colors: the mic or camera is off, or the screen is being shared. */
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
      className={`flex h-12 w-12 items-center justify-center rounded-full text-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tone}`}
    >
      {children}
    </button>
  );
}

/** Ringing notification: who is calling, with Accept and Decline. */
function IncomingCall({ call }: Readonly<{ call: CallView }>) {
  const nameOf = useNameOf();
  const name = nameOf(call.peerId);
  const video = call.media === "video";
  return (
    <section
      aria-label={`Incoming call from ${name}`}
      className="fixed inset-x-3 top-3 z-50 rounded-2xl border border-line bg-surface-raised p-4 text-ink shadow-2xl sm:left-auto sm:right-4 sm:top-4 sm:w-80"
    >
      <p className="sr-only" aria-live="assertive">
        {name} is calling you.
      </p>
      <div className="flex items-center gap-3">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{name}</p>
          <p className="text-sm text-ink-secondary">{statusText(call, "")}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => calls.decline()}
          className="flex items-center justify-center gap-2 rounded-lg bg-error px-3 py-2 text-sm font-semibold text-white hover:bg-error/85"
        >
          <PhoneOffIcon /> Decline
        </button>
        <button
          type="button"
          onClick={() => void calls.accept()}
          className="flex items-center justify-center gap-2 rounded-lg bg-success px-3 py-2 text-sm font-semibold text-on-accent hover:bg-success/85"
        >
          {video ? <VideoIcon /> : <PhoneIcon />} Accept
        </button>
      </div>
    </section>
  );
}

/** Full-screen call: remote video (or avatar) large, local preview small, controls. */
function ActiveCall({ call }: Readonly<{ call: CallView }>) {
  const nameOf = useNameOf();
  const name = nameOf(call.peerId);
  const elapsed = useElapsed(call.connectedAt);
  const remoteVideo =
    call.phase === "connected" && !!call.remoteStream && (call.peer.camOn || call.peer.sharing);
  const canShare = supportsScreenShare();

  return (
    <section
      aria-label={`Call with ${name}`}
      className="fixed inset-0 z-40 flex flex-col bg-[#0E0D12] text-white"
    >
      <StreamMedia kind="audio" stream={call.remoteStream} />

      <header className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{name}</p>
          <p className="text-sm text-white/70" aria-live="polite">
            {statusText(call, elapsed)}
            {call.phase === "connected" && !call.peer.micOn && " · Muted"}
            {call.peer.sharing && " · Sharing screen"}
          </p>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {remoteVideo ? (
          <StreamMedia
            kind="video"
            stream={call.remoteStream}
            muted
            label={`Video from ${name}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <Avatar name={name} size="xl" />
            {call.phase === "connected" && (
              <p className="text-sm text-white/70">
                {call.media === "video" ? "Camera is off" : "Voice call"}
              </p>
            )}
          </div>
        )}

        {call.localVideo && (
          <StreamMedia
            kind="video"
            stream={call.localVideo}
            muted
            label={call.sharing ? "Your shared screen" : "Your camera"}
            className={`absolute bottom-3 right-3 aspect-video w-32 rounded-xl border border-white/20 bg-black object-cover shadow-lg sm:w-56 ${
              call.sharing ? "" : "-scale-x-100"
            }`}
          />
        )}
      </div>

      <footer className="flex items-center justify-center gap-3 px-4 pb-6 pt-4">
        <ControlButton
          label={call.micOn ? "Mute microphone" : "Unmute microphone"}
          highlight={!call.micOn}
          onClick={() => calls.toggleMic()}
        >
          {call.micOn ? <MicIcon /> : <MicOffIcon />}
        </ControlButton>
        <ControlButton
          label={call.camOn ? "Turn camera off" : "Turn camera on"}
          highlight={!call.camOn}
          onClick={() => void calls.toggleCamera()}
        >
          {call.camOn ? <VideoIcon /> : <VideoOffIcon />}
        </ControlButton>
        {canShare && (
          <ControlButton
            label={call.sharing ? "Stop sharing screen" : "Share screen"}
            highlight={call.sharing}
            onClick={() => void calls.toggleScreenShare()}
          >
            <ScreenShareIcon />
          </ControlButton>
        )}
        <ControlButton label="Hang up" danger onClick={() => calls.hangUp()}>
          <PhoneOffIcon />
        </ControlButton>
      </footer>
    </section>
  );
}

/** Mounted once in the chat layout: shows the ringing card or the call view. */
export function CallLayer() {
  const call = useCall((s) => s.call);
  if (!call) return null;
  return call.phase === "incoming" ? <IncomingCall call={call} /> : <ActiveCall call={call} />;
}
