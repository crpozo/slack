import { MAX_ROOM_PARTICIPANTS, type CallRoom } from "@mindfultech/shared";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCall } from "../lib/call";
import { groupCalls, useGroupCall, type GroupCallView, type GroupPeerView } from "../lib/groupCall";
import { supportsScreenShare } from "../lib/media";
import { useChat, useNameOf } from "../store";
import { Avatar } from "./Avatar";
import {
  CloseIcon,
  MaximizeIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  VideoIcon,
  VideoOffIcon,
} from "./icons";
import { ReconnectingOverlay, useSecondsLeft } from "./Reconnecting";
import { StreamMedia } from "./StreamMedia";

// ---------------------------------------------------------------------------
// Channel calls (Phase 36): the header's Start/Join, the call panel above the
// channel's messages (a grid of everyone, or a shared screen on stage), the
// floating window elsewhere in the app, everyone's audio, and the notice when
// someone starts a call. The logic is `groupCalls` (lib/groupCall.ts).
// ---------------------------------------------------------------------------

const ICON_BUTTON =
  "rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-40";

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return "";
  const total = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "You", "Ana", "Ana and Luis", "Ana, Luis and 2 more". */
function namesOf(room: CallRoom, nameOf: (id: string) => string, me: string | undefined): string {
  const names = room.participants.map((p) => (p.userId === me ? "You" : nameOf(p.userId)));
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * In a channel's header: Start a voice/video call, or, while one goes on,
 * who's in it and Join. Nothing rings: this is how people see it.
 */
export function ChannelCallButtons({
  channelId,
  label,
}: Readonly<{ channelId: string; label: string }>) {
  const room = useGroupCall((s) => s.rooms[channelId]);
  const inThisCall = useGroupCall((s) => s.call?.channelId === channelId);
  const inOtherCall = useGroupCall((s) => !!s.call && s.call.channelId !== channelId);
  const inDmCall = useCall((s) => s.call !== null);
  const me = useChat((s) => s.me?.userId);
  const nameOf = useNameOf();
  const busy = inOtherCall || inDmCall;

  if (room && !inThisCall) {
    const full = room.participants.length >= MAX_ROOM_PARTICIPANTS;
    return (
      <div className="flex items-center gap-1" data-room={room.roomId}>
        <span className="hidden -space-x-1 sm:flex" aria-hidden="true">
          {room.participants.slice(0, 4).map((p) => (
            <span key={p.userId} className="rounded-lg ring-2 ring-surface">
              <Avatar name={nameOf(p.userId)} size="xs" mine={p.userId === me} />
            </span>
          ))}
        </span>
        <button
          type="button"
          onClick={() => void groupCalls.join(channelId, "audio")}
          disabled={busy || full}
          title={
            full
              ? `The call is full (${MAX_ROOM_PARTICIPANTS} people)`
              : `In the call: ${namesOf(room, nameOf, me)}`
          }
          aria-label={`Join the call in ${label} (${room.participants.length} in it)`}
          className="flex items-center gap-1.5 rounded-full bg-success px-3 py-1 text-sm font-semibold text-on-accent hover:brightness-95 disabled:opacity-50"
        >
          <PhoneIcon /> Join
          <span className="tabular-nums">· {room.participants.length}</span>
        </button>
        <button
          type="button"
          onClick={() => void groupCalls.join(channelId, "video")}
          disabled={busy || full}
          aria-label={`Join the call in ${label} with video`}
          title="Join with video"
          className={ICON_BUTTON}
        >
          <VideoIcon />
        </button>
      </div>
    );
  }
  if (inThisCall) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-sm font-semibold text-ink">
        <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" /> In the call
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => void groupCalls.join(channelId, "audio")}
        disabled={busy}
        aria-label={`Start a voice call in ${label}`}
        title="Start a call"
        className={ICON_BUTTON}
      >
        <PhoneIcon />
      </button>
      <button
        type="button"
        onClick={() => void groupCalls.join(channelId, "video")}
        disabled={busy}
        aria-label={`Start a video call in ${label}`}
        title="Start a video call"
        className={ICON_BUTTON}
      >
        <VideoIcon />
      </button>
    </>
  );
}

function ControlButton({
  label,
  highlight = false,
  danger = false,
  small = false,
  onClick,
  children,
}: Readonly<{
  label: string;
  highlight?: boolean;
  danger?: boolean;
  small?: boolean;
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
      className={`flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        small ? "h-9 w-9 text-lg" : "h-11 w-11 text-xl"
      } ${tone}`}
    >
      {children}
    </button>
  );
}

function Controls({ call, small = false }: Readonly<{ call: GroupCallView; small?: boolean }>) {
  return (
    <>
      <ControlButton
        label={call.micOn ? "Mute microphone" : "Unmute microphone"}
        highlight={!call.micOn}
        small={small}
        onClick={() => groupCalls.toggleMic()}
      >
        {call.micOn ? <MicIcon /> : <MicOffIcon />}
      </ControlButton>
      <ControlButton
        label={call.camOn ? "Turn camera off" : "Turn camera on"}
        highlight={!call.camOn}
        small={small}
        onClick={() => void groupCalls.toggleCamera()}
      >
        {call.camOn ? <VideoIcon /> : <VideoOffIcon />}
      </ControlButton>
      {!small && supportsScreenShare() && (
        <ControlButton
          label={call.sharing ? "Stop sharing screen" : "Share screen"}
          highlight={call.sharing}
          onClick={() => void groupCalls.toggleScreenShare()}
        >
          <ScreenShareIcon />
        </ControlButton>
      )}
    </>
  );
}

const PEER_STATE: Record<GroupPeerView["state"], string> = {
  waiting: "Joining…",
  connecting: "Connecting…",
  connected: "",
  reconnecting: "Reconnecting…",
};

/** One person: their camera, or their avatar; muted and connection state on top. */
function Tile({
  name,
  stream,
  camOn,
  micOn,
  mine = false,
  status,
  reconnectingUntil,
}: Readonly<{
  name: string;
  stream: MediaStream | null;
  camOn: boolean;
  micOn: boolean;
  mine?: boolean;
  status?: string;
  reconnectingUntil?: number | null;
}>) {
  return (
    <div
      className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-white/5"
      data-tile={name}
    >
      {camOn && stream ? (
        <StreamMedia
          kind="video"
          stream={stream}
          muted
          label={mine ? "Your camera" : `Video from ${name}`}
          className={`h-full w-full object-cover ${mine ? "-scale-x-100" : ""}`}
        />
      ) : (
        <Avatar name={name} size="md" mine={mine} />
      )}
      <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 truncate rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
        {!micOn && <MicOffIcon aria-label="Muted" />}
        {name}
        {status && <span className="text-white/70">· {status}</span>}
      </span>
      {reconnectingUntil ? <ReconnectingOverlay deadline={reconnectingUntil} compact /> : null}
    </div>
  );
}

/** Grid columns for `n` tiles: 1, 2, 2×2, then three across. */
const gridCols = (n: number) =>
  n <= 1 ? "grid-cols-1" : n <= 4 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3";

function Grid({ call }: Readonly<{ call: GroupCallView }>) {
  const nameOf = useNameOf();
  const sharer = call.peers.find((p) => p.sharing && p.screen);
  const tiles = [
    <Tile
      key="me"
      name="You"
      mine
      stream={call.localCamera}
      camOn={call.camOn}
      micOn={call.micOn}
    />,
    ...call.peers.map((p) => (
      <Tile
        key={p.userId}
        name={nameOf(p.userId)}
        stream={p.stream}
        camOn={p.camOn}
        micOn={p.micOn}
        status={PEER_STATE[p.state]}
        reconnectingUntil={p.reconnectingUntil}
      />
    )),
  ];
  const screen = sharer?.screen ?? (call.sharing ? call.localScreen : null);
  if (screen) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2 sm:flex-row">
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-black">
          <StreamMedia
            kind="video"
            stream={screen}
            muted
            label={sharer ? `Screen from ${nameOf(sharer.userId)}` : "Your shared screen"}
            className="h-full w-full object-contain"
          />
        </div>
        <div className="grid shrink-0 auto-rows-[5rem] grid-flow-col gap-2 overflow-x-auto sm:w-44 sm:grid-flow-row sm:auto-rows-[6.5rem] sm:overflow-y-auto">
          {tiles}
        </div>
      </div>
    );
  }
  return (
    <div className={`grid h-full min-h-0 auto-rows-fr gap-2 p-2 ${gridCols(tiles.length)}`}>
      {tiles}
    </div>
  );
}

/** Above the channel's messages while you're in its call. */
export function GroupCallPanel({
  channelId,
  label,
}: Readonly<{ channelId: string; label: string }>) {
  const call = useGroupCall((s) => (s.call?.channelId === channelId ? s.call : null));
  const elapsed = useElapsed(call?.startedAt ?? null);
  if (!call) return null;
  const count = call.peers.length + 1;
  return (
    <section
      aria-label={`Call in ${label}`}
      className="flex h-[min(52vh,560px)] min-h-[300px] shrink-0 flex-col border-b border-line bg-[#0E0D12] text-white"
      data-group-call={call.roomId ?? "joining"}
    >
      <header className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <p className="truncate font-semibold">{label}</p>
        <p className="truncate text-white/70" aria-live="polite">
          {call.phase === "joining"
            ? "Joining…"
            : `${count} of ${MAX_ROOM_PARTICIPANTS} · ${elapsed}`}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <Grid call={call} />
      </div>
      <footer className="flex items-center justify-center gap-3 px-4 py-2.5">
        <Controls call={call} />
        <ControlButton label="Leave the call" danger onClick={() => groupCalls.leave()}>
          <PhoneOffIcon />
        </ControlButton>
      </footer>
    </section>
  );
}

/** The call while you're elsewhere in the app: a small window with the essentials. */
function FloatingGroupCall({ call }: Readonly<{ call: GroupCallView }>) {
  const navigate = useNavigate();
  const nameOf = useNameOf();
  const channelName = useChat(
    (s) => s.channels.find((c) => c.channelId === call.channelId)?.name ?? "channel",
  );
  const elapsed = useElapsed(call.startedAt);
  const speaker = call.peers.find((p) => p.sharing && p.screen) ?? call.peers.find((p) => p.camOn);
  return (
    <div
      role="dialog"
      aria-label={`Call in #${channelName}`}
      className="fixed bottom-4 right-4 z-50 w-64 overflow-hidden rounded-2xl border border-white/15 bg-[#0E0D12] text-white shadow-2xl sm:w-72"
    >
      <div className="relative aspect-video bg-black">
        {speaker ? (
          <StreamMedia
            kind="video"
            stream={speaker.sharing && speaker.screen ? speaker.screen : speaker.stream}
            muted
            label={`Video from ${nameOf(speaker.userId)}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-1.5">
            {call.peers.slice(0, 4).map((p) => (
              <Avatar key={p.userId} name={nameOf(p.userId)} size="md" />
            ))}
            {call.peers.length === 0 && (
              <p className="text-xs text-white/70">Waiting for others…</p>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pt-2 text-sm">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate font-semibold">#{channelName}</p>
        <p className="shrink-0 text-xs tabular-nums text-white/70">
          {call.peers.length + 1} · {elapsed}
        </p>
      </div>
      <div className="flex items-center justify-center gap-2 px-3 py-2.5">
        <Controls call={call} small />
        <ControlButton
          label="Back to the call"
          small
          onClick={() => void navigate(`/app/${encodeURIComponent(call.channelId)}`)}
        >
          <MaximizeIcon />
        </ControlButton>
        <ControlButton label="Leave the call" danger small onClick={() => groupCalls.leave()}>
          <PhoneOffIcon />
        </ControlButton>
      </div>
    </div>
  );
}

/** "Ana started a call in #proj · Join": shown for a little while, never rings. */
function StartedNotice() {
  const notice = useGroupCall((s) => s.notice);
  const room = useGroupCall((s) => (s.notice ? s.rooms[s.notice.channelId] : undefined));
  const inCall = useGroupCall((s) => !!s.call);
  const inDmCall = useCall((s) => s.call !== null);
  const nameOf = useNameOf();
  const channelName = useChat(
    (s) => s.channels.find((c) => c.channelId === notice?.channelId)?.name,
  );
  const left = useSecondsLeft(notice ? notice.at + 15_000 : null);
  const dismiss = () => useGroupCall.setState({ notice: null });
  useEffect(() => {
    if (left === 0) dismiss();
  }, [left]);
  if (!notice || !room || inCall) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-surface-raised px-4 py-2.5 text-sm text-ink shadow-lg"
        data-call-notice={notice.channelId}
      >
        <PhoneIcon className="shrink-0 text-success" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <strong>{nameOf(notice.by)}</strong> started a call
          {channelName ? ` in #${channelName}` : ""}
        </span>
        <button
          type="button"
          disabled={inDmCall}
          onClick={() => {
            dismiss();
            void groupCalls.join(notice.channelId, "audio");
          }}
          className="rounded-full bg-success px-3 py-1 text-sm font-semibold text-on-accent hover:brightness-95 disabled:opacity-50"
        >
          Join
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="text-ink-secondary hover:text-ink"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/**
 * Mounted once in the layout: everyone's audio (it keeps playing wherever
 * you go), the floating window outside the call's channel, and the notice.
 */
export function GroupCallLayer() {
  const call = useGroupCall((s) => s.call);
  const { pathname } = useLocation();
  const inChannel = !!call && pathname === `/app/${call.channelId}`;
  return (
    <>
      {call?.peers.map((p) => (
        <StreamMedia key={p.userId} kind="audio" stream={p.stream} />
      ))}
      {call && !inChannel && <FloatingGroupCall call={call} />}
      <StartedNotice />
    </>
  );
}
