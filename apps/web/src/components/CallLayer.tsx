import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { create } from "zustand";
import { calls, useCall, type CallView } from "../lib/call";
import {
  clampToViewport,
  cornerAfterKey,
  cornerPosition,
  loadCorner,
  nearestCorner,
  saveCorner,
  type Corner,
} from "../lib/floating";
import { listInputDevices, loadMediaPrefs, supportsScreenShare } from "../lib/media";
import { useNameOf } from "../store";
import { Avatar } from "./Avatar";
import {
  CheckIcon,
  ChevronUpIcon,
  MaximizeIcon,
  MicIcon,
  MicOffIcon,
  MinimizeIcon,
  PhoneIcon,
  PhoneOffIcon,
  PictureInPictureIcon,
  ScreenShareIcon,
  VideoIcon,
  VideoOffIcon,
} from "./icons";
import { Popover } from "./Popover";
import { StreamMedia } from "./StreamMedia";

/**
 * Call view size in the chat column: `split` (chat visible below) or expanded to
 * the whole column (ChannelView hides the messages and composer meanwhile).
 */
export const useCallLayout = create<{ expanded: boolean; setExpanded: (v: boolean) => void }>(
  (set) => ({ expanded: false, setExpanded: (expanded) => set({ expanded }) }),
);

/** Whether the call view fills the chat column of `channelId` right now. */
export function useCallExpanded(channelId: string): boolean {
  const here = useCall((s) => s.call?.channelId === channelId && s.call.phase !== "incoming");
  const expanded = useCallLayout((s) => s.expanded);
  return here && expanded;
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
  disabled = false,
  onClick,
  children,
}: Readonly<{
  /** Says what a click does ("Mute microphone"), so it changes with the state. */
  label: string;
  /** Inverted colors: the mic or camera is off, or the screen is being shared. */
  highlight?: boolean;
  danger?: boolean;
  disabled?: boolean;
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
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex h-11 w-11 items-center justify-center rounded-full text-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}

const DEVICE_LABELS = {
  audio: { title: "Microphone", fallback: "Microphone", empty: "No microphones found" },
  video: { title: "Camera", fallback: "Camera", empty: "No cameras found" },
} as const;

/**
 * Chevron next to the mic/camera button: lists the inputs (`enumerateDevices`)
 * and swaps to the chosen one mid-call without renegotiating.
 */
function DeviceMenu({
  kind,
  currentId,
}: Readonly<{ kind: "audio" | "video"; currentId: string | null }>) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const labels = DEVICE_LABELS[kind];
  const close = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    if (!anchor) return;
    const refresh = () =>
      void listInputDevices()
        .then((d) => setDevices(kind === "audio" ? d.microphones : d.cameras))
        .catch(() => setDevices([]));
    refresh();
    const media = navigator.mediaDevices;
    media?.addEventListener("devicechange", refresh);
    return () => media?.removeEventListener("devicechange", refresh);
  }, [anchor, kind]);

  // With the camera off nothing is captured: show the device it will use.
  const prefs = loadMediaPrefs();
  const selected = currentId ?? (kind === "audio" ? prefs.audioInputId : prefs.videoInputId);

  return (
    <>
      <button
        type="button"
        aria-label={`Choose ${labels.title.toLowerCase()}`}
        title={`Choose ${labels.title.toLowerCase()}`}
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="-ml-2 flex h-6 w-6 items-center justify-center self-end rounded-full bg-white/15 text-xs text-white ring-2 ring-[#0E0D12] hover:bg-white/25 focus-visible:outline-none focus-visible:ring-primary"
      >
        <ChevronUpIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close}>
          <section
            aria-label={labels.title}
            className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-surface-raised p-1 text-ink shadow-xl"
          >
            <h3 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
              {labels.title}
            </h3>
            {devices === null && <p className="px-3 py-2 text-sm text-ink-secondary">Loading…</p>}
            {devices?.length === 0 && (
              <p className="px-3 py-2 text-sm text-ink-secondary">{labels.empty}</p>
            )}
            {devices?.map((device, i) => {
              const active =
                device.deviceId === selected || (!selected && device.deviceId === "default");
              return (
                <button
                  key={device.deviceId}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    close();
                    void calls.switchDevice(kind, device.deviceId);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover ${
                    active ? "font-semibold" : ""
                  }`}
                >
                  <CheckIcon className={`shrink-0 ${active ? "text-primary" : "invisible"}`} />
                  <span className="truncate">{device.label || `${labels.fallback} ${i + 1}`}</span>
                </button>
              );
            })}
          </section>
        </Popover>
      )}
    </>
  );
}

/** Ringing notification: who is calling, with Accept and Decline. */
function IncomingCall({ call }: Readonly<{ call: CallView }>) {
  const nameOf = useNameOf();
  const navigate = useNavigate();
  const name = nameOf(call.peerId);
  const video = call.media === "video";
  function accept() {
    navigate(`/app/${call.channelId}`); // the call panel lives in that DM
    void calls.accept();
  }
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
          onClick={accept}
          className="flex items-center justify-center gap-2 rounded-lg bg-success px-3 py-2 text-sm font-semibold text-on-accent hover:bg-success/85"
        >
          {video ? <VideoIcon /> : <PhoneIcon />} Accept
        </button>
      </div>
    </section>
  );
}

/** A participant's camera, or their avatar while it is off. */
function CameraTile({
  stream,
  on,
  name,
  mirrored = false,
  label,
  className = "",
}: Readonly<{
  stream: MediaStream | null;
  on: boolean;
  name: string;
  mirrored?: boolean;
  label: string;
  className?: string;
}>) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-xl border border-white/15 bg-black ${className}`}
    >
      {on && stream ? (
        <StreamMedia
          kind="video"
          stream={stream}
          muted
          label={label}
          className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Avatar name={name} size="md" />
        </div>
      )}
      <span className="absolute bottom-1 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
        {name}
      </span>
    </div>
  );
}

/** The video area: the peer (or a shared screen) on the stage, cameras as tiles. */
function Stage({
  call,
  name,
  connected,
}: Readonly<{ call: CallView; name: string; connected: boolean }>) {
  const peerSharing = connected && call.peer.sharing && !!call.remoteScreen;
  const sharing = peerSharing || !!call.localScreen;
  const peerCamOn = connected && call.peer.camOn && !!call.remoteStream;

  const peerTile = (className: string) => (
    <CameraTile
      stream={call.remoteStream}
      on={peerCamOn}
      name={name}
      label={`Video from ${name}`}
      className={className}
    />
  );
  const myTile = (className: string) => (
    <CameraTile
      stream={call.localCamera}
      on={!!call.localCamera}
      name="You"
      mirrored
      label="Your camera"
      className={className}
    />
  );

  if (sharing) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2 sm:flex-row">
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-black">
          {peerSharing ? (
            <StreamMedia
              kind="video"
              stream={call.remoteScreen}
              muted
              label={`Screen from ${name}`}
              className="h-full w-full object-contain"
            />
          ) : (
            <StreamMedia
              kind="video"
              stream={call.localScreen}
              muted
              label="Your shared screen"
              className="h-full w-full object-contain"
            />
          )}
        </div>
        <div className="flex shrink-0 gap-2 overflow-x-auto sm:w-40 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden">
          {peerTile("aspect-video h-20 sm:h-auto sm:w-full")}
          {myTile("aspect-video h-20 sm:h-auto sm:w-full")}
          {peerSharing && call.localScreen && (
            <div className="relative aspect-video h-20 shrink-0 overflow-hidden rounded-xl border border-white/15 bg-black sm:h-auto sm:w-full">
              <StreamMedia
                kind="video"
                stream={call.localScreen}
                muted
                label="Your shared screen"
                className="h-full w-full object-contain"
              />
              <span className="absolute bottom-1 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
                Your screen
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-full">
      {peerCamOn ? (
        <StreamMedia
          kind="video"
          stream={call.remoteStream}
          muted
          label={`Video from ${name}`}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <Avatar name={name} size="xl" />
          {connected && (
            <p className="text-sm text-white/70">
              {call.media === "video" ? "Camera is off" : "Voice call"}
            </p>
          )}
        </div>
      )}
      {call.localCamera && (
        <div className="absolute bottom-2 right-2 w-28 shadow-lg sm:w-44">
          {myTile("aspect-video w-full")}
        </div>
      )}
    </div>
  );
}

/**
 * In-column call panel (Discord-style): the sidebar and the composer stay
 * usable. Without a screen share, the peer's camera (or avatar) is the stage
 * and your camera is a small picture-in-picture. While a screen is shared it
 * takes the stage and both cameras move to a strip on the right (below, on
 * narrow screens), so nobody's camera is ever hidden.
 */
function ActiveCall({ call }: Readonly<{ call: CallView }>) {
  const nameOf = useNameOf();
  const name = nameOf(call.peerId);
  const elapsed = useElapsed(call.connectedAt);
  const connected = call.phase === "connected";
  const canShare = supportsScreenShare() && call.canShare;
  const expanded = useCallLayout((s) => s.expanded);
  const setExpanded = useCallLayout((s) => s.setExpanded);
  // Every call starts in the split view; leaving it (hang up, other channel) resets it.
  useEffect(() => () => setExpanded(false), [setExpanded]);

  return (
    <section
      aria-label={`Call with ${name}`}
      className={`flex flex-col border-b border-line bg-[#0E0D12] text-white ${
        expanded ? "min-h-0 flex-1" : "h-[min(48vh,520px)] min-h-[300px] shrink-0"
      }`}
    >
      <header className="flex items-center gap-2 px-2 py-2 text-sm">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-pressed={expanded}
          aria-label={expanded ? "Show the chat" : "Expand the call"}
          title={expanded ? "Show the chat" : "Expand the call"}
          className="rounded-md p-1.5 text-white/80 hover:bg-white/15 hover:text-white"
        >
          {expanded ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
        <p className="truncate font-semibold">{name}</p>
        <p className="truncate text-white/70" aria-live="polite">
          {statusText(call, elapsed)}
          {connected && !call.peer.micOn && " · Muted"}
          {call.peer.sharing && " · Sharing screen"}
        </p>
      </header>

      <div className="min-h-0 flex-1">
        <Stage call={call} name={name} connected={connected} />
      </div>

      <footer className="flex items-center justify-center gap-3 px-4 py-2.5">
        <div className="flex">
          <ControlButton
            label={call.micOn ? "Mute microphone" : "Unmute microphone"}
            highlight={!call.micOn}
            onClick={() => calls.toggleMic()}
          >
            {call.micOn ? <MicIcon /> : <MicOffIcon />}
          </ControlButton>
          <DeviceMenu kind="audio" currentId={call.micDeviceId} />
        </div>
        <div className="flex">
          <ControlButton
            label={call.camOn ? "Turn camera off" : "Turn camera on"}
            highlight={!call.camOn}
            onClick={() => void calls.toggleCamera()}
          >
            {call.camOn ? <VideoIcon /> : <VideoOffIcon />}
          </ControlButton>
          <DeviceMenu kind="video" currentId={call.cameraDeviceId} />
        </div>
        {supportsScreenShare() && (
          <ControlButton
            label={call.sharing ? "Stop sharing screen" : "Share screen"}
            highlight={call.sharing}
            disabled={!canShare}
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

/** Native picture-in-picture (Chrome, Edge, Safari, the Windows desktop app). */
const pipSupported = () =>
  typeof document !== "undefined" &&
  "pictureInPictureEnabled" in document &&
  document.pictureInPictureEnabled;

/**
 * The call while you're elsewhere in the app (another channel, a board):
 * a small window floating over everything, like Google Meet's. Drag it
 * anywhere; it snaps to the nearest corner (remembered), arrow keys move it
 * too. Shows the peer's camera or shared screen (or their avatar), your own
 * camera, the timer and the essential controls; the audio keeps playing from
 * `CallLayer`. "Back to call" returns to the full view in the DM.
 */
function FloatingCall({ call }: Readonly<{ call: CallView }>) {
  const nameOf = useNameOf();
  const navigate = useNavigate();
  const name = nameOf(call.peerId);
  const elapsed = useElapsed(call.connectedAt);
  const connected = call.phase === "connected";
  const peerSharing = connected && call.peer.sharing && !!call.remoteScreen;
  const peerCamOn = connected && call.peer.camOn && !!call.remoteStream;

  const cardRef = useRef<HTMLDivElement>(null);
  const [corner, setCorner] = useState<Corner>(loadCorner);
  const [size, setSize] = useState({ w: 288, h: 220 });
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const grab = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [inPip, setInPip] = useState(false);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!video) return;
    const on = () => setInPip(true);
    const off = () => setInPip(false);
    video.addEventListener("enterpictureinpicture", on);
    video.addEventListener("leavepictureinpicture", off);
    return () => {
      video.removeEventListener("enterpictureinpicture", on);
      video.removeEventListener("leavepictureinpicture", off);
    };
  }, [video]);

  const moveTo = (next: Corner) => {
    setCorner(next);
    saveCorner(next);
  };
  const parked = cornerPosition(corner, size.w, size.h, viewport);
  const position = drag ?? parked;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button")) return; // the controls stay clickable
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { dx: e.clientX - position.x, dy: e.clientY - position.y, moved: false };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = grab.current;
    if (!g) return;
    g.moved = true;
    setDrag(clampToViewport(e.clientX - g.dx, e.clientY - g.dy, size.w, size.h, viewport));
  }
  function onPointerUp() {
    const g = grab.current;
    grab.current = null;
    if (!g?.moved || !drag) return setDrag(null);
    moveTo(
      nearestCorner(drag.x + size.w / 2, drag.y + size.h / 2, viewport.width, viewport.height),
    );
    setDrag(null);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    const next = cornerAfterKey(corner, e.key);
    if (!next) return;
    e.preventDefault();
    moveTo(next);
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video?.requestPictureInPicture();
    } catch {
      // Refused (no user gesture, or no video frames yet): the floating window stays.
    }
  }

  const back = () => navigate(`/app/${call.channelId}`);
  let stage: ReactNode;
  if (peerSharing || peerCamOn) {
    stage = (
      <StreamMedia
        kind="video"
        stream={peerSharing ? call.remoteScreen : call.remoteStream}
        muted
        label={peerSharing ? `Screen from ${name}` : `Video from ${name}`}
        className={`h-full w-full ${peerSharing ? "object-contain" : "object-cover"}`}
        onVideo={setVideo}
      />
    );
  } else {
    stage = (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Avatar name={name} size="md" />
        <p className="text-xs text-white/70">
          {connected && call.media === "video" ? "Camera is off" : "Voice call"}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Call with ${name}. Drag to move, or use the arrow keys.`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      className={`fixed left-0 top-0 z-50 w-64 touch-none select-none overflow-hidden rounded-2xl border border-white/15 bg-[#0E0D12] text-white shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:w-72 ${
        drag ? "cursor-grabbing" : "cursor-grab transition-transform duration-200 ease-out"
      }`}
    >
      <div className="relative aspect-video bg-black">
        {stage}
        {inPip && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-xs text-white/80">
            Playing in picture-in-picture
          </div>
        )}
        {call.localCamera && (
          <div className="absolute bottom-1.5 right-1.5 w-20 overflow-hidden rounded-lg border border-white/20 shadow-lg">
            <StreamMedia
              kind="video"
              stream={call.localCamera}
              muted
              label="Your camera"
              className="aspect-video w-full -scale-x-100 object-cover"
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pt-2 text-sm">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate font-semibold">{name}</p>
        <p className="shrink-0 text-xs tabular-nums text-white/70" aria-live="polite">
          {statusText(call, elapsed)}
          {connected && !call.peer.micOn && " · Muted"}
        </p>
      </div>
      <div className="flex items-center justify-center gap-2 px-3 py-2.5">
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
        {pipSupported() && video && (
          <ControlButton
            label={inPip ? "Close picture-in-picture" : "Pop out (picture-in-picture)"}
            highlight={inPip}
            onClick={() => void togglePip()}
          >
            <PictureInPictureIcon />
          </ControlButton>
        )}
        <ControlButton label="Back to the call" onClick={back}>
          <MaximizeIcon />
        </ControlButton>
        <ControlButton label="Hang up" danger onClick={() => calls.hangUp()}>
          <PhoneOffIcon />
        </ControlButton>
      </div>
    </div>
  );
}

/** Lives in the chat column above the messages of the call's own DM (elsewhere: `FloatingCall`). */
export function CallPanel({ channelId }: Readonly<{ channelId: string }>) {
  const call = useCall((s) => s.call);
  if (!call || call.phase === "incoming" || call.channelId !== channelId) return null;
  return <ActiveCall call={call} />;
}

/**
 * Mounted once in the layout, above every route: the ringing card (which may
 * appear anywhere), the peer's audio (which keeps playing wherever you go),
 * and the floating window whenever you're not in the call's own DM.
 */
export function CallLayer() {
  const call = useCall((s) => s.call);
  const { pathname } = useLocation();
  if (!call) return null;
  if (call.phase === "incoming") return <IncomingCall call={call} />;
  const inCallChannel = pathname === `/app/${call.channelId}`;
  return (
    <>
      <StreamMedia kind="audio" stream={call.remoteStream} />
      {!inCallChannel && <FloatingCall call={call} />}
    </>
  );
}
