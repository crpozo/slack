import {
  canAccessChannel,
  GENERAL_CHANNEL_ID,
  isDmChannel,
  type Channel,
} from "@mindfultech/shared";
import { useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { calls, useCall } from "../lib/call";
import { channelLabel, dmPeer } from "../lib/channels";
import { supportsCalls } from "../lib/media";
import { useChat, useIsOnline, useNameOf } from "../store";
import { PresenceDot } from "./Avatar";
import { CallPanel, useCallExpanded } from "./CallLayer";
import { Composer, type ComposerHandle } from "./Composer";
import { EditChannelModal, InviteModal } from "./ChannelModals";
import { HashIcon, LockIcon, MenuIcon, PhoneIcon, UserPlusIcon, VideoIcon } from "./icons";
import { MessageList } from "./MessageList";
import { UnreadAlertsDot } from "./NotificationBell";
import { TypingIndicator } from "./TypingIndicator";

const ICON_BUTTON =
  "rounded-md p-2 text-lg text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

/** What the current user can see and do in `channelId`. */
function channelAccess(
  channelId: string,
  channel: Channel | undefined,
  myUserId: string,
  channelsLoaded: boolean,
) {
  const dm = isDmChannel(channelId);
  const allowed = canAccessChannel(channelId, myUserId);
  const peer = dm ? dmPeer(channelId, myUserId) : null;
  const isPrivate = channel?.type === "private";
  return {
    dm,
    isPrivate,
    peer,
    notFound: !allowed || (channelsLoaded && !channel && !dm),
    canCall: !!peer && peer !== myUserId && allowed && supportsCalls(),
    canInvite: isPrivate && channel?.createdBy === myUserId,
  };
}

type Access = ReturnType<typeof channelAccess>;

function PeerPresence({ peer, myUserId }: Readonly<{ peer: string; myUserId: string }>) {
  const online = useIsOnline(peer) || peer === myUserId;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-secondary">
      <PresenceDot online={online} />
      <span className="hidden sm:inline">{online ? "Online" : "Offline"}</span>
    </span>
  );
}

/** Project channels: straight to their board in the Task Manager. */
function BoardShortcut({ boardId }: Readonly<{ boardId: string }>) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/app/tasks/${encodeURIComponent(boardId)}`)}
      className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-xs font-semibold text-ink hover:bg-primary/25"
      title="Open this project's board"
      aria-label="Open board"
    >
      <span aria-hidden="true">📊</span> Board
    </button>
  );
}

function MemberCount({ channel }: Readonly<{ channel: Channel }>) {
  const count = channel.members?.length ?? 1;
  return (
    <span className="shrink-0 text-xs text-ink-secondary">
      · {count} member{count === 1 ? "" : "s"}
    </span>
  );
}

function CallButtons({
  channelId,
  peer,
  label,
}: Readonly<{ channelId: string; peer: string; label: string }>) {
  const inCall = useCall((s) => s.call !== null);
  return (
    <>
      <button
        type="button"
        onClick={() => void calls.startCall(channelId, peer, "audio")}
        disabled={inCall}
        aria-label={`Start a voice call with ${label}`}
        title="Voice call"
        className={ICON_BUTTON}
      >
        <PhoneIcon />
      </button>
      <button
        type="button"
        onClick={() => void calls.startCall(channelId, peer, "video")}
        disabled={inCall}
        aria-label={`Start a video call with ${label}`}
        title="Video call"
        className={ICON_BUTTON}
      >
        <VideoIcon />
      </button>
    </>
  );
}

function ChannelHeader({
  channelId,
  channel,
  label,
  access,
  myUserId,
  onOpenSidebar,
  onInvite,
  onDetails,
}: Readonly<{
  channelId: string;
  channel: Channel | undefined;
  label: string;
  access: Access;
  myUserId: string;
  onOpenSidebar: () => void;
  onInvite: () => void;
  /** Opens the channel's details (editable by its creator or an admin). */
  onDetails: () => void;
}>) {
  const { dm, isPrivate, peer } = access;
  const KindIcon = isPrivate ? LockIcon : HashIcon;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
      <button
        type="button"
        onClick={onOpenSidebar}
        className="relative rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
        aria-label="Open menu"
      >
        <MenuIcon />
        <UnreadAlertsDot />
      </button>
      {!dm && <KindIcon className="shrink-0 text-ink-secondary" />}
      {dm || !channel ? (
        <h1 className="truncate font-semibold text-ink">{label}</h1>
      ) : (
        <button
          type="button"
          onClick={onDetails}
          className="flex min-w-0 flex-col items-start rounded-md px-1 py-0.5 text-left hover:bg-surface-hover"
          title={channel.description || "Channel details"}
        >
          <h1 className="max-w-full truncate font-semibold leading-tight text-ink">{label}</h1>
          {channel.topic && (
            <span className="max-w-full truncate text-xs leading-tight text-ink-secondary">
              {channel.topic}
            </span>
          )}
        </button>
      )}
      {peer && <PeerPresence peer={peer} myUserId={myUserId} />}
      {isPrivate && channel && <MemberCount channel={channel} />}
      {channel?.isProject && channel.linkedBoardId && (
        <BoardShortcut boardId={channel.linkedBoardId} />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {access.canCall && peer && <CallButtons channelId={channelId} peer={peer} label={label} />}
        {access.canInvite && (
          <button
            type="button"
            onClick={onInvite}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink"
          >
            <UserPlusIcon />
            <span className="hidden sm:inline">Invite</span>
          </button>
        )}
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-ink">This channel doesn't exist or you don't have access.</p>
      <Link to={`/app/${GENERAL_CHANNEL_ID}`} className="btn-primary">
        Go to #general
      </Link>
    </div>
  );
}

export function ChannelView({
  channelId,
  onOpenSidebar,
}: Readonly<{
  channelId: string;
  onOpenSidebar: () => void;
}>) {
  const me = useChat((s) => s.me);
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const nameOf = useNameOf();
  const [inviting, setInviting] = useState(false);
  const [details, setDetails] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  // The call fills the column: messages and composer stay mounted but hidden.
  const callExpanded = useCallExpanded(channelId);

  if (!me) return null;
  const access = channelAccess(channelId, channel, me.userId, channelsLoaded);
  const label = channelLabel(channelId, channel, me.userId, (id) => nameOf(id));
  const title = access.dm ? label : `#${label}`;

  function handleDragOver(e: DragEvent) {
    if (!channel || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) composer.current?.addFiles(e.dataTransfer.files);
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <ChannelHeader
        channelId={channelId}
        channel={channel}
        label={label}
        access={access}
        myUserId={me.userId}
        onOpenSidebar={onOpenSidebar}
        onInvite={() => setInviting(true)}
        onDetails={() => setDetails(true)}
      />
      {inviting && channel && <InviteModal channel={channel} onClose={() => setInviting(false)} />}
      {details && channel && (
        <EditChannelModal channel={channel} onClose={() => setDetails(false)} />
      )}

      {access.notFound ? (
        <NotFound />
      ) : (
        <>
          <CallPanel channelId={channelId} />
          <div className={callExpanded ? "hidden" : "contents"}>
            <MessageList channelId={channelId} title={title} />
            <TypingIndicator channelId={channelId} />
            <Composer
              key={channelId}
              ref={composer}
              channelId={channelId}
              disabled={!channel}
              placeholder={channel ? `Message ${title}` : "Opening conversation…"}
            />
          </div>
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10">
          <p className="rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-ink shadow">
            Drop to attach to {title}
          </p>
        </div>
      )}
    </div>
  );
}
