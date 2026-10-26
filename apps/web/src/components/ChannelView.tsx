import {
  canAccessChannel,
  GENERAL_CHANNEL_ID,
  isDmChannel,
  type Channel,
} from "@mindfultech/shared";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { calls, useCall } from "../lib/call";
import { channelLabel, dmPeer } from "../lib/channels";
import { supportsCalls } from "../lib/media";
import { useChat, useIsOnline, useNameOf, type ChatMessage } from "../store";
import { PresenceDot } from "./Avatar";
import { CallPanel, useCallExpanded } from "./CallLayer";
import { ChannelCallButtons, GroupCallPanel } from "./GroupCall";
import { Composer, type ComposerHandle } from "./Composer";
import { EditChannelModal, InviteModal } from "./ChannelModals";
import {
  ArchiveIcon,
  ArrowDownIcon,
  HashIcon,
  LinkIcon,
  LockIcon,
  MenuIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  PinIcon,
  PinOffIcon,
  UserPlusIcon,
  VideoIcon,
} from "./icons";
import { ThreadPanel } from "./ThreadPanel";
import { ChannelBoardPane } from "./ChannelBoardPane";
import { PaneResizer, usePaneSplit } from "./PaneResizer";
import { useBoardPane } from "../store/boardPane";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/hooks";
import { MessageList } from "./MessageList";
import { UnreadAlertsDot } from "./NotificationBell";
import { TypingIndicator } from "./TypingIndicator";
import { PhoneChannelHeader, PhoneChannelSheet, PhoneIntro } from "./PhoneChannel";
import {
  ConversationDetailsModal,
  PinnedMessagesModal,
  type DetailsTab,
  type JumpTarget,
} from "./ConversationPanels";
import { Popover } from "./Popover";
import { chat } from "../lib/chat";

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
    /** Phase 36: channel calls (rooms) in any channel you can post in. */
    canRoomCall: !dm && allowed && !!channel && !channel.archived && supportsCalls(),
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

/**
 * Project channels: their board. On desktop it toggles the board beside the
 * chat (the 50/50 pane); on phones it opens the Task Manager full screen.
 */
function BoardShortcut({ channelId, boardId }: Readonly<{ channelId: string; boardId: string }>) {
  const navigate = useNavigate();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const open = useBoardPane((s) => !!s.open[channelId]);
  const setOpen = useBoardPane((s) => s.setOpen);
  const showing = desktop && open;
  return (
    <button
      type="button"
      onClick={() =>
        desktop ? setOpen(channelId, !open) : navigate(`/app/tasks/${encodeURIComponent(boardId)}`)
      }
      aria-pressed={desktop ? showing : undefined}
      className={`ml-1 flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold text-ink ${
        showing
          ? "border-primary bg-primary/30 hover:bg-primary/40"
          : "border-primary/40 bg-primary/15 hover:bg-primary/25"
      }`}
      title={
        desktop
          ? showing
            ? "Hide the board"
            : "Show this project's board beside the chat"
          : "Open this project's board"
      }
      aria-label={desktop ? (showing ? "Hide board" : "Show board") : "Open board"}
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
  onBack,
  access,
  myUserId,
  onOpenSidebar,
  onInvite,
  onDetails,
  onPins,
}: Readonly<{
  channelId: string;
  channel: Channel | undefined;
  label: string;
  access: Access;
  myUserId: string;
  onOpenSidebar: () => void;
  onBack?: () => void;
  onInvite: () => void;
  /** Opens the conversation's details (Phase 38: About, Members, Files & Links). */
  onDetails: (tab?: DetailsTab) => void;
  /** Opens its pinned messages (Phase 38). */
  onPins: () => void;
}>) {
  const { dm, isPrivate, peer } = access;
  const KindIcon = isPrivate ? LockIcon : HashIcon;
  const pinCount = channel?.pinCount ?? 0;
  const sidebarPinned = useChat((s) => s.pinned.includes(channelId));
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const menuItem =
    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-primary/15";
  return (
    // Glass (Phase 37b): it floats over the conversation, which scrolls under it.
    <header className="glass absolute inset-x-0 top-0 z-20 flex h-14 items-center gap-2 border-b border-white/10 px-3 sm:px-4">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Back"
        >
          <ArrowDownIcon className="rotate-90" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpenSidebar}
          className="relative rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Open menu"
        >
          <MenuIcon />
          <UnreadAlertsDot />
        </button>
      )}
      {!dm && <KindIcon className="shrink-0 text-ink-secondary" />}
      {!channel ? (
        <h1 className="truncate font-semibold text-ink">{label}</h1>
      ) : dm ? (
        <button
          type="button"
          onClick={() => onDetails("members")}
          className="min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-surface-hover"
          title="Conversation details"
        >
          <h1 className="truncate font-semibold text-ink">{label}</h1>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onDetails("about")}
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
        <BoardShortcut channelId={channelId} boardId={channel.linkedBoardId} />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {channel && (
          <button
            type="button"
            onClick={onPins}
            className="flex items-center gap-1 rounded-md p-2 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink"
            aria-label={`Pinned messages (${pinCount})`}
            title="Pinned messages"
            data-pins-button
          >
            <PinIcon />
            {pinCount > 0 && <span className="text-xs font-semibold tabular-nums">{pinCount}</span>}
          </button>
        )}
        {access.canCall && peer && <CallButtons channelId={channelId} peer={peer} label={label} />}
        {access.canRoomCall && <ChannelCallButtons channelId={channelId} label={label} />}
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
        {channel && (
          <button
            type="button"
            onClick={(e) => setMoreAnchor(moreAnchor ? null : e.currentTarget)}
            className={ICON_BUTTON}
            aria-label="Conversation options"
            aria-haspopup="menu"
            aria-expanded={!!moreAnchor}
            title="More"
          >
            <MoreHorizontalIcon />
          </button>
        )}
        {moreAnchor && (
          <Popover anchor={moreAnchor} onClose={() => setMoreAnchor(null)}>
            <div
              role="menu"
              aria-label="Conversation options"
              className="glass-strong w-64 rounded-xl border border-white/10 p-1"
            >
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMoreAnchor(null);
                  chat.setPinned(channelId, !sidebarPinned);
                }}
              >
                {sidebarPinned ? <PinOffIcon /> : <PinIcon />}
                {sidebarPinned ? "Unpin from the sidebar" : "Pin to the top of the sidebar"}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMoreAnchor(null);
                  onDetails("media");
                }}
              >
                <LinkIcon /> Files &amp; Links
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMoreAnchor(null);
                  onDetails(dm ? "members" : "about");
                }}
              >
                <PencilIcon /> {dm ? "Conversation details" : "Channel details"}
              </button>
            </div>
          </Popover>
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
  onBack,
  threadId,
  onOpenThread,
  onCloseThread,
}: Readonly<{
  channelId: string;
  onOpenSidebar: () => void;
  /** Phones with the tab bar: a back arrow instead of the menu button. */
  onBack?: () => void;
  /** The open thread's parent message id (desktop: side panel; phones: its own screen). */
  threadId?: string;
  onOpenThread?: (message: ChatMessage) => void;
  onCloseThread?: () => void;
}>) {
  const me = useChat((s) => s.me);
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const nameOf = useNameOf();
  const [inviting, setInviting] = useState(false);
  const [details, setDetails] = useState(false);
  const [options, setOptions] = useState(false);
  // Phase 38: the pinned messages, or the details on a tab.
  const [panel, setPanel] = useState<"pins" | DetailsTab | null>(null);
  const jump = (target: JumpTarget) => {
    setPanel(null);
    setOptions(false);
    chat.jumpTo({ channelId: target.channelId, sk: target.messageSk, parentSk: target.parentSk });
  };
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  // The call fills the column: messages and composer stay mounted but hidden.
  const callExpanded = useCallExpanded(channelId);
  const threadParent = useChat((s) =>
    threadId ? s.messagesByChannel[channelId]?.find((m) => m.messageId === threadId) : undefined,
  );
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const boardOpen = useBoardPane((s) => !!s.open[channelId]);
  // The right pane's width (desktop): dragged on the divider, remembered per kind.
  const rowRef = useRef<HTMLDivElement>(null);
  const threadSplit = usePaneSplit("thread");
  const boardSplit = usePaneSplit("board");
  const setBoardOpen = useBoardPane((s) => s.setOpen);
  // Its parent was deleted while the thread was open (Phase 32): close it.
  const hadThreadParent = useRef(false);
  useEffect(() => {
    if (threadParent) hadThreadParent.current = true;
    else if (threadId && hadThreadParent.current) {
      hadThreadParent.current = false;
      onCloseThread?.();
    }
  }, [threadParent, threadId, onCloseThread]);

  if (!me) return null;
  const archived = !!channel?.archived;
  // The right pane on desktop: a thread while one is open, else the project's
  // board when it's toggled on (phones open the Task Manager instead).
  const boardId = channel?.isProject ? channel.linkedBoardId : undefined;
  const showBoard = desktop && boardOpen && !!boardId && !threadParent;
  // Phones: the thread takes the whole screen, header included.
  const mobileThread = !!threadParent && !desktop;
  const access = channelAccess(channelId, channel, me.userId, channelsLoaded);
  const label = channelLabel(channelId, channel, me.userId, (id) => nameOf(id));
  const title = access.dm ? label : `#${label}`;
  // Phones (Phase 37): Slack's mobile header and the "very beginning" intro.
  const phone = !desktop && !!onBack;

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
      {!mobileThread && phone && onBack && (
        <PhoneChannelHeader
          channelId={channelId}
          channel={channel}
          label={label}
          access={access}
          onBack={onBack}
          onOpenOptions={() => setOptions(true)}
        />
      )}
      {options && (
        <PhoneChannelSheet
          channelId={channelId}
          channel={channel}
          title={title}
          access={access}
          onClose={() => setOptions(false)}
          onDetails={(tab) => setPanel(tab)}
          onPins={() => setPanel("pins")}
          onInvite={() => setInviting(true)}
        />
      )}
      {panel === "pins" && (
        <PinnedMessagesModal
          channelId={channelId}
          title={title}
          onClose={() => setPanel(null)}
          onJump={jump}
        />
      )}
      {panel && panel !== "pins" && (
        <ConversationDetailsModal
          channelId={channelId}
          title={title}
          initialTab={panel}
          onClose={() => setPanel(null)}
          onJump={jump}
          onEdit={() => {
            setPanel(null);
            setDetails(true);
          }}
        />
      )}
      {!mobileThread && !phone && (
        <ChannelHeader
          channelId={channelId}
          channel={channel}
          label={label}
          access={access}
          myUserId={me.userId}
          onOpenSidebar={onOpenSidebar}
          onBack={onBack}
          onInvite={() => setInviting(true)}
          onDetails={(tab) => setPanel(tab ?? "about")}
          onPins={() => setPanel("pins")}
        />
      )}
      {/* Under the floating header: the archived note and an ongoing call, when
          there are any. With none, the conversation itself starts under the
          header instead (`--list-inset`), so it scrolls beneath the glass. */}
      <div className={phone || mobileThread ? "" : "peer pt-14 empty:pt-0"} data-top-stack>
        {archived && !mobileThread && (
          <div
            className="flex items-center justify-center gap-2 border-b border-line bg-warning/15 px-4 py-1.5 text-xs font-medium text-ink"
            role="status"
          >
            <ArchiveIcon /> This channel is archived
          </div>
        )}
        {!access.notFound && (
          <>
            <CallPanel channelId={channelId} />
            <GroupCallPanel channelId={channelId} label={title} />
          </>
        )}
      </div>
      {inviting && channel && <InviteModal channel={channel} onClose={() => setInviting(false)} />}
      {details && channel && (
        <EditChannelModal channel={channel} onClose={() => setDetails(false)} />
      )}

      {access.notFound ? (
        <NotFound />
      ) : (
        <>
          <div
            ref={rowRef}
            className={`${callExpanded ? "hidden" : "flex min-h-0 flex-1"} ${
              phone || mobileThread ? "" : "peer-empty:[--list-inset:3.5rem]"
            }`}
          >
            {/* Phones show the thread instead of the conversation; desktop beside it. */}
            <div
              className={`flex min-h-0 min-w-0 flex-1 flex-col ${
                threadParent && !desktop ? "hidden" : ""
              }`}
            >
              <MessageList
                channelId={channelId}
                title={title}
                onOpenThread={onOpenThread}
                intro={
                  phone
                    ? (hasMessages) => (
                        <PhoneIntro
                          channel={channel}
                          title={title}
                          access={access}
                          hasMessages={hasMessages}
                          onAddDescription={() => setDetails(true)}
                          onAddPeople={() => setInviting(true)}
                        />
                      )
                    : undefined
                }
              />
              <TypingIndicator channelId={channelId} />
              <Composer
                key={channelId}
                ref={composer}
                channelId={channelId}
                disabled={!channel}
                readOnly={archived}
                placeholder={channel ? `Message ${title}` : "Opening conversation…"}
              />
            </div>
            {threadParent && onCloseThread && desktop && (
              <PaneResizer
                rowRef={rowRef}
                percent={threadSplit.percent}
                onChange={threadSplit.set}
                onCommit={threadSplit.commit}
                onReset={threadSplit.reset}
                label="Resize the thread"
              />
            )}
            {threadParent && onCloseThread && (
              <div
                className="flex min-h-0 w-full flex-col pt-[var(--list-inset,0px)] md:shrink-0"
                style={desktop ? { width: `${threadSplit.percent}%` } : undefined}
                data-thread-pane
              >
                <ThreadPanel
                  channelId={channelId}
                  parent={threadParent}
                  onClose={onCloseThread}
                  readOnly={archived}
                />
              </div>
            )}
            {showBoard && boardId && (
              <PaneResizer
                rowRef={rowRef}
                percent={boardSplit.percent}
                onChange={boardSplit.set}
                onCommit={boardSplit.commit}
                onReset={boardSplit.reset}
                label="Resize the board"
              />
            )}
            {showBoard && boardId && (
              <div
                className="flex min-h-0 shrink-0 flex-col pt-[var(--list-inset,0px)]"
                style={{ width: `${boardSplit.percent}%` }}
                data-board-pane
              >
                <ChannelBoardPane
                  boardId={boardId}
                  onClose={() => setBoardOpen(channelId, false)}
                />
              </div>
            )}
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
