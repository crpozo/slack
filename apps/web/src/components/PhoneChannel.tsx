import { canEditChannel, MAX_ROOM_PARTICIPANTS, type Channel } from "@mindfultech/shared";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { calls, useCall } from "../lib/call";
import { groupCalls, useGroupCall } from "../lib/groupCall";
import { useChat, useIsOnline } from "../store";
import { Avatar } from "./Avatar";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  HashIcon,
  HeadphonesIcon,
  KanbanIcon,
  LockIcon,
  PencilIcon,
  UserPlusIcon,
  VideoIcon,
} from "./icons";
import { Modal } from "./Modal";

// ---------------------------------------------------------------------------
// Phones (Phase 37): a conversation's header and intro after Slack's mobile
// app. A round back button, the name in a pill (tap it for the channel's
// options), and 🎧 to start or join the channel's call (a voice call in DMs).
// ---------------------------------------------------------------------------

export interface PhoneAccess {
  dm: boolean;
  isPrivate: boolean;
  peer: string | null;
  canCall: boolean;
  canRoomCall: boolean;
  canInvite: boolean;
}

const ROUND =
  "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-surface-raised text-[24px] text-ink shadow-[0_4px_16px_rgb(0_0_0/0.3)] active:bg-surface-hover disabled:opacity-40";

/** How many people are in the channel: its members, or everyone for a public one. */
function useMemberCount(channel: Channel | undefined): number {
  const everyone = useChat((s) => Math.max(1, Object.keys(s.users).length));
  return channel?.members?.length ?? everyone;
}

/** 🎧: start or join the channel's call (voice); in a DM, call the other person. */
function HuddleButton({
  channelId,
  label,
  access,
}: Readonly<{ channelId: string; label: string; access: PhoneAccess }>) {
  const room = useGroupCall((s) => s.rooms[channelId]);
  const inThisCall = useGroupCall((s) => s.call?.channelId === channelId);
  const inGroupCall = useGroupCall((s) => !!s.call);
  const inDmCall = useCall((s) => s.call !== null);
  if (access.canRoomCall) {
    const full = !!room && room.participants.length >= MAX_ROOM_PARTICIPANTS;
    const live = !!room;
    return (
      <button
        type="button"
        onClick={() => void groupCalls.join(channelId, "audio")}
        disabled={inThisCall || (inGroupCall && !inThisCall) || inDmCall || full}
        aria-label={
          inThisCall
            ? `You're in the call in ${label}`
            : live
              ? `Join the call in ${label} (${room.participants.length} in it)`
              : `Start a call in ${label}`
        }
        title={full ? `The call is full (${MAX_ROOM_PARTICIPANTS} people)` : undefined}
        data-huddle={live ? "live" : "idle"}
        className={`${ROUND} relative ${live ? "border-success/60 text-success" : ""}`}
      >
        <HeadphonesIcon />
        {live && (
          <span className="absolute -right-1 -top-1 min-w-[1.25rem] rounded-full bg-success px-1 text-center text-[11px] font-bold leading-5 text-on-accent ring-2 ring-surface">
            {room.participants.length}
          </span>
        )}
      </button>
    );
  }
  if (access.canCall && access.peer) {
    const peer = access.peer;
    return (
      <button
        type="button"
        onClick={() => void calls.startCall(channelId, peer, "audio")}
        disabled={inDmCall || inGroupCall}
        aria-label={`Start a voice call with ${label}`}
        className={ROUND}
      >
        <HeadphonesIcon />
      </button>
    );
  }
  return <span className="h-12 w-12 shrink-0" aria-hidden="true" />;
}

export function PhoneChannelHeader({
  channelId,
  channel,
  label,
  access,
  onBack,
  onOpenOptions,
}: Readonly<{
  channelId: string;
  channel: Channel | undefined;
  label: string;
  access: PhoneAccess;
  onBack: () => void;
  onOpenOptions: () => void;
}>) {
  const members = useMemberCount(channel);
  const room = useGroupCall((s) => s.rooms[channelId]);
  const peerOnline = useIsOnline(access.peer);
  const self = useChat((s) => s.me?.userId === access.peer);
  const KindIcon = access.isPrivate ? LockIcon : HashIcon;
  const subtitle: ReactNode[] = [];
  if (access.dm) subtitle.push(peerOnline || self ? "Active" : "Away");
  else {
    subtitle.push(`${members} member${members === 1 ? "" : "s"}`);
    if (channel?.isProject && channel.linkedBoardId) subtitle.push("board");
  }
  return (
    <header className="flex shrink-0 items-center gap-2.5 bg-surface px-3 py-2" data-phone-header>
      <button type="button" onClick={onBack} aria-label="Back" className={ROUND}>
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        onClick={onOpenOptions}
        aria-haspopup="dialog"
        aria-label={`${access.dm ? label : `#${label}`}: options`}
        className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-line bg-surface-raised px-4 text-left shadow-[0_4px_16px_rgb(0_0_0/0.3)] active:bg-surface-hover"
      >
        {access.dm ? (
          <Avatar name={label} size="sm" mine={self} />
        ) : (
          <KindIcon className="shrink-0 text-[20px] text-ink" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] font-bold leading-tight text-ink">
            {label}
          </span>
          <span className="block truncate text-[13px] leading-tight text-ink-secondary">
            {subtitle.join(" • ")}
            {room && (
              <span className="font-semibold text-success">
                {" "}
                • {room.participants.length} in call
              </span>
            )}
          </span>
        </span>
      </button>
      <HuddleButton channelId={channelId} label={access.dm ? label : `#${label}`} access={access} />
    </header>
  );
}

function OptionRow({
  icon,
  label,
  hint,
  onClick,
}: Readonly<{ icon: ReactNode; label: string; hint?: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-hover"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-xl text-ink">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-semibold text-ink">{label}</span>
        {hint && <span className="block truncate text-sm text-ink-secondary">{hint}</span>}
      </span>
      <ChevronRightIcon className="shrink-0 text-ink-secondary" aria-hidden="true" />
    </button>
  );
}

/** The pill's sheet: details, people, the board, a video call. */
export function PhoneChannelSheet({
  channelId,
  channel,
  title,
  access,
  onClose,
  onDetails,
  onInvite,
}: Readonly<{
  channelId: string;
  channel: Channel | undefined;
  title: string;
  access: PhoneAccess;
  onClose: () => void;
  onDetails: () => void;
  onInvite: () => void;
}>) {
  const navigate = useNavigate();
  const inDmCall = useCall((s) => s.call !== null);
  const inGroupCall = useGroupCall((s) => !!s.call);
  const busy = inDmCall || inGroupCall;
  const then = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const boardId = channel?.isProject ? channel.linkedBoardId : undefined;
  const rows: ReactNode[] = [];
  if (channel && !access.dm) {
    rows.push(
      <OptionRow
        key="details"
        icon={<PencilIcon />}
        label="Channel details"
        hint={channel.description || channel.topic || "Name, topic and description"}
        onClick={then(onDetails)}
      />,
    );
  }
  if (access.canInvite) {
    rows.push(
      <OptionRow
        key="invite"
        icon={<UserPlusIcon />}
        label="Add people"
        onClick={then(onInvite)}
      />,
    );
  }
  if (boardId) {
    rows.push(
      <OptionRow
        key="board"
        icon={<KanbanIcon />}
        label="Open the board"
        hint="This project's tasks"
        onClick={then(() => navigate(`/app/tasks/${encodeURIComponent(boardId)}`))}
      />,
    );
  }
  if (!busy && (access.canRoomCall || (access.canCall && access.peer))) {
    rows.push(
      <OptionRow
        key="video"
        icon={<VideoIcon />}
        label={access.canRoomCall ? "Video call" : `Video call ${title}`}
        onClick={then(() => {
          if (access.canRoomCall) void groupCalls.join(channelId, "video");
          else if (access.peer) void calls.startCall(channelId, access.peer, "video");
        })}
      />,
    );
  }
  return (
    <Modal title={title} width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {rows.length ? (
          rows
        ) : (
          <p className="px-4 py-6 text-sm text-ink-secondary">Nothing to change here.</p>
        )}
      </div>
    </Modal>
  );
}

/** The top of a conversation on phones: "This is the very beginning of #name". */
export function PhoneIntro({
  channel,
  title,
  access,
  hasMessages,
  onAddDescription,
  onAddPeople,
}: Readonly<{
  channel: Channel | undefined;
  title: string;
  access: PhoneAccess;
  hasMessages: boolean;
  onAddDescription: () => void;
  onAddPeople: () => void;
}>) {
  const me = useChat((s) => s.me);
  const canDescribe = !!channel && !!me && canEditChannel(channel, me.userId, me.role);
  const pill =
    "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border border-line bg-surface px-3 py-4 text-[17px] font-semibold text-ink active:bg-surface-hover";
  return (
    <div className="px-4 pb-4 pt-10" data-phone-intro>
      <p className="break-words text-[34px] font-extrabold leading-tight text-ink">{title}</p>
      <p className="mt-3 text-[17px] leading-snug text-ink-secondary">
        {access.dm
          ? `This is the very beginning of your direct message history with ${title}.`
          : `This is the very beginning of the ${title} channel.`}
        {channel?.description && !access.dm && (
          <span className="mt-2 block text-ink">{channel.description}</span>
        )}
      </p>
      {!access.dm && (canDescribe || access.canInvite) && (
        <div className="mt-6 flex gap-3">
          {canDescribe && (
            <button type="button" onClick={onAddDescription} className={pill}>
              <PencilIcon className="text-2xl" />
              {channel?.description ? "Edit description" : "Add description"}
            </button>
          )}
          {access.canInvite && (
            <button type="button" onClick={onAddPeople} className={pill}>
              <UserPlusIcon className="text-2xl" />
              Add people
            </button>
          )}
        </div>
      )}
      {!hasMessages && (
        <p className="mt-6 text-sm text-ink-secondary">No messages yet. Be the first to write!</p>
      )}
    </div>
  );
}
