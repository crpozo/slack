import { canAccessChannel, isDmChannel } from "@mindfultech/shared";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { channelLabel } from "../lib/channels";
import { useChat, useNameOf } from "../store";
import { Composer, type ComposerHandle } from "./Composer";
import { InviteModal } from "./ChannelModals";
import { HashIcon, LockIcon, MenuIcon, UserPlusIcon } from "./icons";
import { MessageList } from "./MessageList";

export function ChannelView({
  channelId,
  onOpenSidebar,
}: {
  channelId: string;
  onOpenSidebar: () => void;
}) {
  const me = useChat((s) => s.me);
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const nameOf = useNameOf();
  const [inviting, setInviting] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);

  if (!me) return null;
  const dm = isDmChannel(channelId);
  const label = channelLabel(channelId, channel, me.userId, (id) => nameOf(id));
  const isPrivate = channel?.type === "private";
  const canInvite = isPrivate && channel.createdBy === me.userId;
  const title = dm ? label : `#${label}`;
  const allowed = canAccessChannel(channelId, me.userId);
  const notFound = !allowed || (channelsLoaded && !channel && !dm);

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) composer.current?.addFiles(e.dataTransfer.files);
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!channel || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Open menu"
        >
          <MenuIcon />
        </button>
        {!dm &&
          (isPrivate ? (
            <LockIcon className="text-ink-secondary" />
          ) : (
            <HashIcon className="text-ink-secondary" />
          ))}
        <h1 className="truncate font-semibold text-ink">{label}</h1>
        {isPrivate && (
          <span className="shrink-0 text-xs text-ink-secondary">
            · {channel.members?.length ?? 1} member
            {(channel.members?.length ?? 1) === 1 ? "" : "s"}
          </span>
        )}
        {canInvite && (
          <button
            type="button"
            onClick={() => setInviting(true)}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink"
          >
            <UserPlusIcon />
            <span className="hidden sm:inline">Invite</span>
          </button>
        )}
      </header>
      {inviting && channel && <InviteModal channel={channel} onClose={() => setInviting(false)} />}

      {notFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-ink">This channel doesn't exist or you don't have access.</p>
          <Link to="/app/ch_general" className="btn-primary">
            Go to #general
          </Link>
        </div>
      ) : (
        <>
          <MessageList channelId={channelId} title={title} />
          <Composer
            key={channelId}
            ref={composer}
            channelId={channelId}
            disabled={!channel}
            placeholder={channel ? `Message ${title}` : "Opening conversation…"}
          />
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
