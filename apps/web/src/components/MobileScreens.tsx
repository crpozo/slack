import { isDmChannel, type Board } from "@mindfultech/shared";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { channelLabel, dmPeer, formatDay, formatTime } from "../lib/channels";
import { useGroupCall } from "../lib/groupCall";
import { loadRecents } from "../lib/recents";
import { tasksApiConfigured } from "../lib/tasksApi";
import { selectUnread, useChat, useNameOf } from "../store";
import { useNotifications, useUnreadAlerts, type AppAlert } from "../store/notifications";
import { useTasks } from "../store/tasks";
import { Avatar, StatusBadge } from "./Avatar";
import { ChannelIcon } from "./ChannelIcon";
import {
  BellIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DmsIcon,
  HashIcon,
  HeadphonesIcon,
  HistoryIcon,
  HomeIcon,
  KanbanIcon,
  LogOutIcon,
  MessageIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
} from "./icons";
import { Logo } from "./LoginPage";
import { Modal } from "./Modal";
import { useSwitcherItems } from "./QuickSwitcher";

const NewTaskModal = lazy(() =>
  import("./NewTaskModal").then((m) => ({ default: m.NewTaskModal })),
);

// ---------------------------------------------------------------------------
// Phones (Phase 23, redesigned in Phase 37 after Slack's mobile app): a
// floating tab bar (Home, DMs, Activity, More) with Search in its own circle,
// a brand-green "+" button above it, and full-screen tabs. The bar stays inside
// conversations too, and steps aside while the keyboard is up.
// ---------------------------------------------------------------------------

export const MOBILE_HOME = "/app/home";

const TABS = [
  { path: "/app/home", label: "Home" },
  { path: "/app/dms", label: "DMs" },
  { path: "/app/activity", label: "Activity" },
  { path: "more", label: "More" },
] as const;

function TabIcon({ path, active }: Readonly<{ path: string; active: boolean }>) {
  if (path === "/app/home") return <HomeIcon filled={active} />;
  if (path === "/app/dms") return <DmsIcon />;
  if (path === "/app/activity") return <BellIcon />;
  return <MoreHorizontalIcon />;
}

function CountBadge({ count }: Readonly<{ count: number }>) {
  if (count <= 0) return null;
  return (
    <span
      className="absolute -right-2.5 -top-1.5 min-w-[1.15rem] rounded-full bg-error px-1 text-center text-[10px] font-bold leading-[1.15rem] text-white ring-2 ring-surface-raised"
      aria-label={`${count} unread`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Folds its children away (height and opacity) while `hidden`, and takes them
 * out of the tab order then. Used for the bar while the keyboard is up.
 */
function Collapsible({ hidden, children }: Readonly<{ hidden: boolean; children: ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // React 18 doesn't know `inert` yet.
    if (ref.current) ref.current.inert = hidden;
  }, [hidden]);
  return (
    <div
      ref={ref}
      aria-hidden={hidden || undefined}
      data-hidden={hidden || undefined}
      className={`grid shrink-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
        hidden ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
      }`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * The tab bar: four tabs in a floating rounded bar, and Search in a circle of
 * its own on the right. It paints edge-to-edge (its background runs under the
 * home indicator) and pads its buttons above it.
 */
export function BottomTabs({
  hidden,
  moreOpen,
  onOpenMore,
}: Readonly<{ hidden: boolean; moreOpen: boolean; onOpenMore: () => void }>) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const unreadChannels = useChat((s) =>
    s.channels.reduce((sum, c) => sum + (c.type === "dm" ? 0 : selectUnread(s, c.channelId)), 0),
  );
  const unreadDms = useChat((s) =>
    s.channels.reduce((sum, c) => sum + (c.type === "dm" ? selectUnread(s, c.channelId) : 0), 0),
  );
  const unreadAlerts = useUnreadAlerts();
  const badge = (path: string) =>
    path === "/app/home"
      ? unreadChannels
      : path === "/app/dms"
        ? unreadDms
        : path === "/app/activity"
          ? unreadAlerts
          : 0;
  const searchActive = pathname === "/app/search" && !moreOpen;
  // Channels and apps are reached from Home (DMs from DMs): that tab stays lit there.
  const dmOpen = isDmChannel(decodeURIComponent(pathname.split("/")[2] ?? ""));
  const activePath = searchActive
    ? null
    : TABS.some((t) => t.path === pathname)
      ? pathname
      : dmOpen
        ? "/app/dms"
        : "/app/home";
  return (
    <Collapsible hidden={hidden}>
      <div
        className="flex items-center gap-3 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
        data-tabbar
      >
        <nav
          className="glass flex min-w-0 flex-1 items-center rounded-full border border-white/10 p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_8px_24px_rgb(0_0_0/0.35)]"
          aria-label="Main"
        >
          {TABS.map((tab) => {
            const isMore = tab.path === "more";
            const active = isMore ? moreOpen : tab.path === activePath && !moreOpen;
            return (
              <button
                key={tab.path}
                type="button"
                onClick={() => (isMore ? onOpenMore() : navigate(tab.path))}
                aria-current={active ? "page" : undefined}
                aria-haspopup={isMore ? "dialog" : undefined}
                className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[11px] font-semibold transition-colors ${
                  active ? "bg-surface-hover text-primary" : "text-ink"
                }`}
              >
                <span className="relative text-[22px]">
                  <TabIcon path={tab.path} active={active} />
                  {!isMore && <CountBadge count={badge(tab.path)} />}
                </span>
                {tab.label}
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={() => navigate("/app/search")}
          aria-label="Search"
          aria-current={searchActive ? "page" : undefined}
          className={`glass flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full border border-white/10 text-[26px] shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_8px_24px_rgb(0_0_0/0.35)] transition-colors ${
            searchActive ? "text-primary" : "text-ink"
          }`}
        >
          <SearchIcon />
        </button>
      </div>
    </Collapsible>
  );
}

/** The green "+" floating above the bar's right end: new message, channel or task. */
export function Fab({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Create"
      aria-haspopup="dialog"
      data-fab
      className="absolute bottom-3 right-5 z-20 flex h-[60px] w-[60px] items-center justify-center rounded-full bg-primary text-[28px] text-on-primary shadow-[0_8px_24px_rgb(0_0_0/0.45)] ring-1 ring-white/10 transition-transform active:scale-95"
    >
      <PlusIcon />
    </button>
  );
}

/** A row of a phone sheet: icon tile, label, hint, chevron. */
function SheetRow({
  icon,
  label,
  hint,
  onClick,
  tone = "text-ink",
}: Readonly<{
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  tone?: string;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-hover ${tone}`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-xl">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-semibold">{label}</span>
        {hint && <span className="block truncate text-sm text-ink-secondary">{hint}</span>}
      </span>
      <ChevronRightIcon className="shrink-0 text-ink-secondary" aria-hidden="true" />
    </button>
  );
}

/** The FAB's sheet. */
export function CreateSheet({
  onClose,
  onNewMessage,
  onNewChannel,
  onNewTask,
}: Readonly<{
  onClose: () => void;
  onNewMessage: () => void;
  onNewChannel: () => void;
  onNewTask: () => void;
}>) {
  return (
    <Modal title="Create" width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <SheetRow
          icon={<MessageIcon />}
          label="New message"
          hint="Write to someone directly"
          onClick={onNewMessage}
        />
        <SheetRow
          icon={<HashIcon />}
          label="New channel"
          hint="A place for a team or a topic"
          onClick={onNewChannel}
        />
        <SheetRow
          icon={<CheckCircleIcon />}
          label="New task"
          hint="Add it to one of your boards"
          onClick={onNewTask}
        />
      </div>
    </Modal>
  );
}

/** "New task" from the FAB: pick a board, then the usual task form. */
export function NewTaskSheet({ onClose }: Readonly<{ onClose: () => void }>) {
  const navigate = useNavigate();
  const boards = useTasks((s) => s.boards);
  const loaded = useTasks((s) => s.boardsLoaded);
  const loadBoards = useTasks((s) => s.loadBoards);
  const [board, setBoard] = useState<Board | null>(null);
  const configured = tasksApiConfigured();
  useEffect(() => {
    if (configured) void loadBoards();
  }, [configured, loadBoards]);

  if (board) {
    return (
      <Suspense fallback={null}>
        <NewTaskModal board={board} onClose={onClose} />
      </Suspense>
    );
  }
  let content: ReactNode;
  if (!configured) {
    content = (
      <p className="px-4 py-6 text-sm text-ink-secondary">Tasks aren&apos;t set up here.</p>
    );
  } else if (!loaded) {
    content = <p className="px-4 py-6 text-sm text-ink-secondary">Loading boards…</p>;
  } else if (boards.length === 0) {
    content = (
      <div className="space-y-3 px-4 py-6 text-sm text-ink-secondary">
        <p>You have no boards yet.</p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            onClose();
            navigate("/app/tasks");
          }}
        >
          Open Task Manager
        </button>
      </div>
    );
  } else {
    content = boards.map((b) => (
      <SheetRow key={b.boardId} icon={<KanbanIcon />} label={b.name} onClick={() => setBoard(b)} />
    ));
  }
  return (
    <Modal title="Add a task to…" width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{content}</div>
    </Modal>
  );
}

/** The history button's sheet: the conversations opened last on this device. */
export function RecentsSheet({ onClose }: Readonly<{ onClose: () => void }>) {
  const navigate = useNavigate();
  const me = useChat((s) => s.me);
  const channels = useChat((s) => s.channels);
  const online = useChat((s) => s.online);
  const nameOf = useNameOf();
  const recents = useMemo(() => (me ? loadRecents(me.userId) : []), [me]);
  if (!me) return null;
  const rows = recents.flatMap((r) => {
    const channel = channels.find((c) => c.channelId === r.channelId);
    if (!channel) return []; // deleted, or left since
    const label = channelLabel(r.channelId, channel, me.userId, (id) => nameOf(id));
    return [{ ...r, channel, label }];
  });
  return (
    <Modal title="Recent" width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-secondary">
            Conversations you open show up here.
          </p>
        ) : (
          <ul aria-label="Recent conversations">
            {rows.map(({ channelId, channel, label, at }) => {
              const peer = dmPeer(channelId, me.userId);
              const self = peer === me.userId;
              return (
                <li key={channelId}>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate(`/app/${channelId}`);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-hover"
                  >
                    {channel.type === "dm" ? (
                      <span className="relative">
                        <Avatar name={label} size="md" mine={self} />
                        <StatusBadge online={self || (!!peer && !!online[peer])} />
                      </span>
                    ) : (
                      <span className="flex h-9 w-9 items-center justify-center text-xl text-ink-secondary">
                        <ChannelIcon channel={channel} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-base text-ink">{label}</span>
                    <span className="shrink-0 text-xs text-ink-secondary">
                      {formatDay(at) === "Today" ? formatTime(at) : formatDay(at)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** The Huddles card's sheet: the calls going on in your channels. */
export function HuddlesSheet({ onClose }: Readonly<{ onClose: () => void }>) {
  const navigate = useNavigate();
  const rooms = useGroupCall((s) => s.rooms);
  const channels = useChat((s) => s.channels);
  const me = useChat((s) => s.me?.userId);
  const nameOf = useNameOf();
  const live = Object.values(rooms);
  return (
    <Modal title="Huddles" width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {live.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-secondary">
            No calls right now. Start one from a channel&apos;s 🎧 button.
          </p>
        ) : (
          live.map((room) => {
            const channel = channels.find((c) => c.channelId === room.channelId);
            const names = room.participants
              .map((p) => (p.userId === me ? "you" : nameOf(p.userId)))
              .join(", ");
            return (
              <SheetRow
                key={room.roomId}
                icon={<HeadphonesIcon className="text-success" />}
                label={`#${channel?.name ?? room.channelId}`}
                hint={`${room.participants.length} in the call · ${names}`}
                onClick={() => {
                  onClose();
                  navigate(`/app/${room.channelId}`);
                }}
              />
            );
          })
        )}
      </div>
    </Modal>
  );
}

/** Home's header: the workspace (opens More), recent conversations, and you. */
export function MobileHomeHeader({
  onOpenWorkspace,
  onOpenHistory,
  onOpenProfile,
}: Readonly<{
  onOpenWorkspace: () => void;
  onOpenHistory: () => void;
  onOpenProfile: () => void;
}>) {
  const me = useChat((s) => s.me);
  const connected = useChat((s) => s.status === "open");
  const nameOf = useNameOf();
  if (!me) return null;
  const myName = nameOf(me.userId, me.email);
  return (
    <header
      className="shrink-0 bg-gradient-to-b from-[#14533C] to-[#0E3328] px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
      data-home-header
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenWorkspace}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label="MindfulTech workspace"
          aria-haspopup="dialog"
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white ring-2 ring-white/15 [&>img]:h-9 [&>img]:w-9 [&>img]:rounded-none">
            <Logo />
          </span>
          <span className="truncate text-2xl font-bold text-white">MindfulTech</span>
          <ChevronDownIcon className="shrink-0 text-xl text-white/80" aria-hidden="true" />
        </button>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-black/20 p-1">
          <button
            type="button"
            onClick={onOpenHistory}
            aria-label="Recent conversations"
            aria-haspopup="dialog"
            className="flex h-10 w-10 items-center justify-center rounded-full text-[22px] text-white active:bg-white/10"
          >
            <HistoryIcon />
          </button>
          <button
            type="button"
            onClick={onOpenProfile}
            aria-label={`${myName}: profile and settings`}
            className="relative flex h-10 w-10 items-center justify-center rounded-full active:bg-white/10"
          >
            <Avatar name={myName} mine size="md" />
            <StatusBadge online={connected} ringClass="ring-[#0E3328] bg-[#0E3328]" />
          </button>
        </div>
      </div>
    </header>
  );
}

/** One shortcut card: icon, title, a count or a hint. */
function ShortcutCard({
  icon,
  title,
  detail,
  onClick,
  live = false,
}: Readonly<{
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  live?: boolean;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-[7.75rem] shrink-0 snap-start flex-col items-start gap-1.5 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left active:bg-surface-hover"
    >
      <span className={`text-[22px] ${live ? "text-success" : "text-ink"}`}>{icon}</span>
      <span className="text-base font-medium text-ink">{title}</span>
      <span className={`text-sm ${live ? "font-semibold text-success" : "text-ink-secondary"}`}>
        {detail}
      </span>
    </button>
  );
}

/** Home's shortcut row (Slack's Threads / Huddles / To-dos / Saved, mapped to ours). */
export function ShortcutCards({ onOpenHuddles }: Readonly<{ onOpenHuddles: () => void }>) {
  const navigate = useNavigate();
  const liveCalls = useGroupCall((s) => Object.keys(s.rooms).length);
  const newAlerts = useUnreadAlerts();
  const boards = useTasks((s) => (s.boardsLoaded ? s.boards.length : null));
  const today = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  return (
    <div
      className="flex snap-x gap-2.5 overflow-x-auto border-b border-line px-4 py-3 [scrollbar-width:none]"
      aria-label="Shortcuts"
      role="group"
    >
      <ShortcutCard
        icon={<HeadphonesIcon />}
        title="Huddles"
        detail={`${liveCalls} live`}
        live={liveCalls > 0}
        onClick={onOpenHuddles}
      />
      <ShortcutCard
        icon={<BellIcon />}
        title="Activity"
        detail={`${newAlerts} new`}
        onClick={() => navigate("/app/activity")}
      />
      <ShortcutCard
        icon={<CheckCircleIcon />}
        title="Tasks"
        detail={boards === null ? "Boards" : `${boards} board${boards === 1 ? "" : "s"}`}
        onClick={() => navigate("/app/tasks")}
      />
      <ShortcutCard
        icon={<CalendarIcon />}
        title="Calendar"
        detail={today}
        onClick={() => navigate("/app/calendar")}
      />
    </div>
  );
}

/** The More tab's sheet (and the workspace menu): who you are, AI Notes, AI News, settings and sign out. */
export function MoreSheet({
  onClose,
  onOpenNotes,
  onOpenNews,
  onOpenSettings,
  onSignOut,
}: Readonly<{
  onClose: () => void;
  onOpenNotes: () => void;
  onOpenNews: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}>) {
  const me = useChat((s) => s.me);
  const connected = useChat((s) => s.status === "open");
  const nameOf = useNameOf();
  if (!me) return null;
  return (
    <Modal title="More" width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-hover"
        >
          <span className="relative">
            <Avatar name={nameOf(me.userId, me.email)} mine size="md" />
            <StatusBadge online={connected} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-ink">
              {nameOf(me.userId, me.email)}
            </span>
            <span className="block truncate text-sm text-ink-secondary">{me.email}</span>
          </span>
          <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
        </button>
        <div className="my-1 border-t border-line" />
        <SheetRow
          icon={<SparklesIcon className="text-primary" />}
          label="AI Notes"
          hint="Summaries of your calls"
          onClick={onOpenNotes}
        />
        <SheetRow
          icon={<span aria-hidden="true">📰</span>}
          label="AI News"
          hint="The latest from TechCrunch"
          onClick={onOpenNews}
        />
        <SheetRow
          icon={<SettingsIcon />}
          label="Settings"
          hint="Notifications, audio & video"
          onClick={onOpenSettings}
        />
        <SheetRow icon={<LogOutIcon />} label="Sign out" onClick={onSignOut} tone="text-error" />
      </div>
    </Modal>
  );
}

/** A tab's screen: a title bar with optional actions, then its content. */
export function MobileScreen({
  title,
  actions,
  children,
}: Readonly<{ title: string; actions?: ReactNode; children: ReactNode }>) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <h1 className="min-w-0 flex-1 truncate text-2xl font-bold text-ink">{title}</h1>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** The bell's list as a screen. Opening it marks everything read. */
export function ActivityScreen() {
  const alerts = useNotifications((s) => s.alerts);
  const navigate = useNavigate();
  const open = (alert: AppAlert) => {
    useNotifications.getState().markAllRead();
    void navigate(alert.url);
  };
  return (
    <MobileScreen
      title="Activity"
      actions={
        alerts.length > 0 && (
          <button
            type="button"
            onClick={() => useNotifications.getState().clear()}
            className="rounded-lg px-2 py-1 text-sm text-ink-secondary hover:bg-surface-hover"
          >
            Clear all
          </button>
        )
      }
    >
      {alerts.length === 0 ? (
        <p className="px-6 py-12 text-center text-base text-ink-secondary">
          Nothing new. DMs, @mentions, board and calendar activity show up here.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <button
                type="button"
                onClick={() => open(alert)}
                className="flex w-full gap-3 px-4 py-3.5 text-left active:bg-surface-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span
                      className={`truncate text-base text-ink ${alert.read ? "" : "font-semibold"}`}
                    >
                      {alert.title}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-ink-secondary">
                      {formatDay(alert.at) === "Today" ? formatTime(alert.at) : formatDay(alert.at)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-sm text-ink-secondary">{alert.body}</span>
                </span>
                {!alert.read && (
                  <span
                    className="mt-2 h-2 w-2 shrink-0 rounded-full bg-error"
                    aria-label="Unread"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </MobileScreen>
  );
}

/** The quick switcher as a screen: channels (archived ones too) and people. */
export function SearchScreen() {
  const [query, setQuery] = useState("");
  const items = useSwitcherItems(query, () => {});
  return (
    <MobileScreen title="Search">
      <div className="sticky top-0 bg-surface px-4 py-3">
        <label className="flex items-center gap-2 rounded-full border border-line bg-surface-raised px-4">
          <SearchIcon className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels or people…"
            aria-label="Search"
            autoFocus
            className="w-full bg-transparent py-3 text-base text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
      </div>
      <ul role="listbox" className="py-1">
        {items.map((item) => (
          <li key={item.key} role="option" aria-selected={false}>
            <button
              type="button"
              onClick={item.go}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-base text-ink active:bg-surface-hover"
            >
              {item.kind === "channel" ? (
                <ChannelIcon channel={{ type: item.channelType ?? "public" }} />
              ) : (
                <span className="w-[1em] text-center text-ink-secondary">@</span>
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="truncate text-sm text-ink-secondary">{item.hint}</span>
              )}
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-4 py-6 text-center text-base text-ink-secondary">No results</li>
        )}
      </ul>
    </MobileScreen>
  );
}
