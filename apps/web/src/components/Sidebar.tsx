import {
  canDeleteChannel,
  canEditChannel,
  dmChannelId,
  MAX_UNREAD_COUNT,
  type Channel,
} from "@mindfultech/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { LONG_PRESS_MS, SLOP_PX, swallowNextClick } from "../lib/gestures";
import { dmEntries, orderChannels, orderDms, type DmEntry } from "../lib/channels";
import {
  loadPhoneSections,
  savePhoneSections,
  type PhoneSection,
  type PhoneSections,
} from "../lib/sidebar";
import type { WsStatus } from "../lib/ws";
import { selectUnread, useChat, useNameOf } from "../store";
import { Avatar, PresenceDot, StatusBadge } from "./Avatar";
import { ChannelIcon } from "./ChannelIcon";
import { DeleteChannelModal, EditChannelModal } from "./ChannelModals";
import { Modal } from "./Modal";
import { NotificationBell } from "./NotificationBell";
import { Popover } from "./Popover";
import {
  AppsIcon,
  ArchiveIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DmsIcon,
  HashIcon,
  KanbanIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  NewspaperIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  TrashIcon,
} from "./icons";
import { Logo } from "./LoginPage";

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘ K" : "Ctrl K";

const STATUS: Record<WsStatus, { dot: string; label: string }> = {
  idle: { dot: "bg-warning", label: "Connecting…" },
  connecting: { dot: "bg-warning", label: "Connecting…" },
  open: { dot: "bg-success", label: "Connected" },
  reconnecting: { dot: "bg-warning", label: "Reconnecting…" },
  closed: { dot: "bg-error", label: "Disconnected" },
};

/** Unread messages as a number: red for DMs and @mentions, the brand color for channels. */
function UnreadBadge({
  count,
  compact,
  urgent,
}: Readonly<{ count: number; compact: boolean; urgent: boolean }>) {
  if (count === 0) return null;
  const color = urgent ? "bg-error" : "bg-sky";
  const text = count > MAX_UNREAD_COUNT ? `${MAX_UNREAD_COUNT}+` : String(count);
  const label = `${text} unread${urgent ? " (for you)" : ""}`;
  if (compact) {
    return (
      <span
        className={`absolute -right-0.5 -top-0.5 min-w-[1.125rem] rounded-full border-2 border-surface-sidebar px-1 text-center text-[10px] font-bold leading-[0.875rem] text-on-accent ${color}`}
        aria-label={label}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      className={`ml-auto min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-on-accent ${color}`}
      aria-label={label}
    >
      {text}
    </span>
  );
}

interface NavItemProps {
  active: boolean;
  unread: number;
  /** The unread badge is red (a DM, or a channel where you were @mentioned). */
  urgent?: boolean;
  compact: boolean;
  /** Visible text, and the tooltip in compact mode. */
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  /** Items of the row's ⋯ menu (not shown in the icon-only rail). */
  menu?: RowMenuItem[];
  /** Pinned to the top of its list (a pin next to the name). */
  pinned?: boolean;
}

interface RowMenuItem {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * ⋯ button of a sidebar row: shown on hover/focus with a mouse, always on
 * touch screens (no hover there). Destructive actions live here, not in the
 * conversation header, so they can't be hit by accident.
 */
function RowMenu({ label, items }: Readonly<{ label: string; items: RowMenuItem[] }>) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label={`More options for ${label}`}
        title="More options"
        aria-haspopup="menu"
        data-row-menu
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={`absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${
          anchor ? "opacity-100" : "opacity-0"
        }`}
      >
        <MoreHorizontalIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div
            role="menu"
            aria-label={`Options for ${label}`}
            className="glass-strong w-52 rounded-xl border border-white/10 p-1"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                  item.danger ? "text-error hover:bg-error/10" : "text-ink hover:bg-surface-hover"
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function dmTitle(dm: DmEntry, compact: boolean): string {
  if (!dm.userId) return "This person hasn't signed in yet";
  return compact ? dm.name : dm.email;
}

function NavItem({
  active,
  unread,
  urgent = false,
  compact,
  label,
  icon,
  disabled,
  title,
  onClick,
  menu,
  pinned = false,
}: Readonly<NavItemProps>) {
  let tone = "text-ink-secondary hover:bg-surface-hover hover:text-ink";
  if (active) tone = "bg-primary/20 font-semibold text-ink";
  else if (unread > 0) tone = "font-semibold text-ink hover:bg-surface-hover";
  return (
    <li
      className="group relative"
      // Right-click opens the row's ⋯ menu (Phase 38), like a native sidebar.
      onContextMenu={(e) => {
        const trigger = e.currentTarget.querySelector<HTMLButtonElement>("[data-row-menu]");
        if (compact || !trigger) return;
        e.preventDefault();
        trigger.click();
      }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title ?? (compact ? label : undefined)}
        aria-label={compact ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={`relative flex w-full items-center gap-2 rounded-md text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? "h-10 justify-center px-0" : "px-2 py-1.5"
        } ${menu?.length && !compact ? "pr-8" : ""} ${tone}`}
      >
        <span className="flex shrink-0 items-center justify-center">{icon}</span>
        {!compact && <span className="truncate">{label}</span>}
        {pinned && !compact && (
          <PinIcon className="shrink-0 text-xs text-ink-secondary" aria-label="Pinned" />
        )}
        <UnreadBadge count={unread} compact={compact} urgent={urgent} />
      </button>
      {!compact && menu && menu.length > 0 && <RowMenu label={label} items={menu} />}
    </li>
  );
}

function Section({
  title,
  action,
  compact,
  children,
}: Readonly<{
  title: string;
  action?: ReactNode;
  compact: boolean;
  children: ReactNode;
}>) {
  return (
    <section className={compact ? "mt-3 border-t border-white/10 pt-3 first:border-0" : "mt-4"}>
      {compact ? (
        action && <div className="mb-1 flex justify-center">{action}</div>
      ) : (
        <div className="flex items-center justify-between px-4 pb-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            {title}
          </h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// --- Phones (Phase 37) -------------------------------------------------------------

/**
 * A row's options on phones: a long press (or a right click) opens them as a
 * sheet, like Slack's, instead of a ⋯ on every row. Keyboard users still get
 * a ⋯ button, shown when it has focus.
 */
function useLongPress(enabled: boolean, onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** It fired: the lift that follows must not click, nor reach the sheet's backdrop. */
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);
  if (!enabled) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      start.current = { x: e.clientX, y: e.clientY };
      fired.current = false;
      timer.current = setTimeout(() => {
        cancel();
        fired.current = true;
        swallowNextClick(); // the lift mustn't also open the conversation
        navigator.vibrate?.(10);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const from = start.current;
      if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // Not passive in React: cancelling it stops the mouse events a lift makes.
    onTouchEnd: (e: React.TouchEvent) => {
      if (!fired.current) return;
      fired.current = false;
      if (e.cancelable) e.preventDefault();
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancel();
      onLongPress();
    },
  };
}

/** A large Slack-style row: icon, name (bold when unread), badge; options on a long press. */
function PhoneRow({
  label,
  icon,
  unread,
  urgent = false,
  title,
  disabled,
  faded = false,
  chip,
  pinned = false,
  onClick,
  menu,
}: Readonly<{
  label: string;
  icon: ReactNode;
  unread: number;
  urgent?: boolean;
  title?: string;
  disabled?: boolean;
  faded?: boolean;
  /** A small label after the name (Apps: "APP"). */
  chip?: string;
  pinned?: boolean;
  onClick: () => void;
  menu?: RowMenuItem[];
}>) {
  const tone = unread > 0 ? "font-bold text-ink" : faded ? "text-ink-secondary" : "text-ink/85";
  const [options, setOptions] = useState(false);
  const hasMenu = !!menu && menu.length > 0;
  const press = useLongPress(hasMenu, () => setOptions(true));
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        {...press}
        className={`flex w-full touch-manipulation select-none items-center gap-4 px-4 py-2 text-left text-[17px] [-webkit-touch-callout:none] active:bg-surface-hover disabled:opacity-50 ${tone}`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center">{icon}</span>
        <span className="truncate">{label}</span>
        {chip && (
          <span className="shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 text-xs font-semibold tracking-wide text-ink-secondary">
            {chip}
          </span>
        )}
        {pinned && <PinIcon className="shrink-0 text-sm text-ink-secondary" aria-label="Pinned" />}
        <UnreadBadge count={unread} compact={false} urgent={urgent} />
      </button>
      {hasMenu && (
        <button
          type="button"
          onClick={() => setOptions(true)}
          aria-label={`More options for ${label}`}
          aria-haspopup="dialog"
          className="sr-only rounded-md p-1 text-ink-secondary focus:not-sr-only focus:absolute focus:right-3 focus:top-1/2 focus:-translate-y-1/2"
        >
          <MoreHorizontalIcon />
        </button>
      )}
      {options && menu && (
        <Modal title={label} width="sm" onClose={() => setOptions(false)}>
          <div
            role="menu"
            aria-label={`Options for ${label}`}
            className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          >
            {menu.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOptions(false);
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left text-base font-semibold active:bg-surface-hover ${
                  item.danger ? "text-error" : "text-ink"
                }`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-xl">
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </li>
  );
}

/** The faded "+ Add channel" / "+ Start a new message" at the end of a list. */
function AddRow({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-4 px-4 py-2.5 text-left text-[17px] text-ink-secondary active:bg-surface-hover"
      >
        <span className="flex w-9 shrink-0 justify-center text-[24px]">
          <PlusIcon />
        </span>
        {label}
      </button>
    </li>
  );
}

/**
 * A folding section: its icon and bold title (with a › to the full list when
 * there is one) and a caret that folds it away, remembered on the device.
 */
function PhoneSectionBlock({
  title,
  icon,
  folded,
  onToggle,
  onOpen,
  openLabel,
  children,
}: Readonly<{
  title: string;
  icon: ReactNode;
  folded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  openLabel?: string;
  children: ReactNode;
}>) {
  const id = `phone-section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  const heading = (
    <>
      <span className="flex w-9 shrink-0 justify-center text-[24px] text-ink">{icon}</span>
      <span className="text-[17px] font-bold text-ink">{title}</span>
    </>
  );
  return (
    <section className="border-b border-line py-2 last:border-0" aria-labelledby={`${id}-title`}>
      <div className="flex items-center pr-2">
        <h2 id={`${id}-title`} className="min-w-0 flex-1">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={openLabel}
              className="flex items-center gap-4 py-2.5 pl-4 pr-2 text-left"
            >
              {heading}
              <ChevronRightIcon className="text-lg text-ink" aria-hidden="true" />
            </button>
          ) : (
            <span className="flex items-center gap-4 py-2.5 pl-4">{heading}</span>
          )}
        </h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          aria-controls={id}
          aria-label={folded ? `Show ${title}` : `Hide ${title}`}
          className="rounded-full p-2.5 text-[22px] text-ink-secondary active:bg-surface-hover"
        >
          <ChevronUpIcon
            className={`transition-transform duration-200 ${folded ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {!folded && (
        <ul id={id} className="pb-1">
          {children}
        </ul>
      )}
    </section>
  );
}

interface PhoneApp {
  path: string;
  label: string;
  tile: string;
  icon: ReactNode;
}

/** Apps on phones, each with its square tile. */
const PHONE_APPS: PhoneApp[] = [
  {
    path: "/app/tasks",
    label: "Task Manager",
    tile: "bg-gradient-to-br from-[#7C3AED] to-[#4A154B] text-white",
    icon: <KanbanIcon />,
  },
  {
    path: "/app/calendar",
    label: "Calendar",
    tile: "bg-gradient-to-br from-[#36C5F0] to-[#1264A3] text-white",
    icon: <CalendarIcon />,
  },
  {
    path: "/app/notes",
    label: "AI Notes",
    tile: "bg-gradient-to-br from-[#ECB22E] to-[#E01E5A] text-white",
    icon: <SparklesIcon />,
  },
  {
    path: "/app/news",
    label: "AI News",
    tile: "bg-gradient-to-br from-[#40B375] to-[#1F6E47] text-white",
    icon: <NewspaperIcon />,
  },
];

function AppTile({ app }: Readonly<{ app: PhoneApp }>) {
  return (
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-lg text-xl shadow-sm ${app.tile}`}
      aria-hidden="true"
    >
      {app.icon}
    </span>
  );
}

interface SidebarProps {
  activeChannelId: string;
  /** Phones' tab screens: one section, full width, no header or footer. */
  only?: "channels" | "dms";
  /**
   * Phones (Phase 37): Slack's mobile lists. Channels, Direct Messages and Apps
   * as folding sections with large rows (or only the DM rows, with `only`).
   */
  phone?: boolean;
  /** Icon-only rail (desktop). */
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onOpenSwitcher: () => void;
  onCreateChannel: () => void;
  onNewDm: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

export function Sidebar({
  activeChannelId,
  only,
  phone = false,
  collapsed,
  onToggleCollapsed,
  onOpenSwitcher,
  onCreateChannel,
  onNewDm,
  onOpenSettings,
  onSignOut,
}: Readonly<SidebarProps>) {
  const navigate = useNavigate();
  const nameOf = useNameOf();
  const [deleting, setDeleting] = useState<{ channel: Channel; label: string } | null>(null);
  const [editing, setEditing] = useState<Channel | null>(null);
  const { me, status, channels, pinned, team, directory, users, online } = useChat(
    useShallow((s) => ({
      me: s.me,
      status: s.status,
      channels: s.channels,
      pinned: s.pinned,
      team: s.team,
      directory: s.directory,
      users: s.users,
      online: s.online,
    })),
  );
  const unread = useChat(
    useShallow((s) =>
      Object.fromEntries(s.channels.map((c) => [c.channelId, selectUnread(s, c.channelId)])),
    ),
  );
  const mentioned = useChat((s) => s.mentioned);

  // `#general` on top, then whoever wrote last: a new message moves its
  // conversation up at once (the store bumps `lastMessageAt` on `message.new`).
  const namedChannels = useMemo(
    () => orderChannels(channels.filter((c) => c.type !== "dm" && !c.archived)),
    [channels],
  );
  const archivedChannels = useMemo(
    () => orderChannels(channels.filter((c) => c.type !== "dm" && c.archived)),
    [channels],
  );
  const [showArchived, setShowArchived] = useState(false);
  const [folded, setFolded] = useState<PhoneSections>(loadPhoneSections);
  const toggleSection = useCallback((section: PhoneSection) => {
    setFolded((prev) => {
      const next = { ...prev, [section]: !prev[section] };
      savePhoneSections(next);
      return next;
    });
  }, []);
  const dms = useMemo(
    () =>
      me
        ? orderDms(
            dmEntries(team, channels, me, directory, (id) => dmChannelId(me.userId, id), users),
            channels,
            pinned,
          )
        : [],
    [team, channels, me, directory, users, pinned],
  );

  if (!me) return null;
  const statusInfo = STATUS[status];
  // Phase 38: the Pinned section, channels and DMs in pin order; they leave
  // their usual sections (no duplicates). Archived channels never show there.
  const pinnedSet = new Set(pinned);
  const pinnedItems = pinned.flatMap(
    (id): Array<{ kind: "channel"; channel: Channel } | { kind: "dm"; dm: DmEntry }> => {
      const channel = namedChannels.find((c) => c.channelId === id);
      if (channel) return [{ kind: "channel", channel }];
      const dm = dms.find((d) => d.channelId === id);
      return dm ? [{ kind: "dm", dm }] : [];
    },
  );
  const shownChannels = namedChannels.filter((c) => !pinnedSet.has(c.channelId));
  const shownDms = dms.filter((d) => !d.channelId || !pinnedSet.has(d.channelId));
  const myName = nameOf(me.userId, me.email);
  const compact = collapsed;

  function openDm(userId: string) {
    const id = chat.openDm(userId);
    if (id) navigate(`/app/${id}`);
  }

  function dmMenu(dm: (typeof dms)[number]): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    const channel = dm.channelId && channels.find((c) => c.channelId === dm.channelId);
    if (channel) {
      const isPinned = pinned.includes(channel.channelId);
      items.push({
        label: isPinned ? "Unpin" : "Pin to the top",
        icon: isPinned ? <PinOffIcon /> : <PinIcon />,
        onSelect: () => chat.setPinned(channel.channelId, !isPinned),
      });
      items.push({
        label: "Delete conversation",
        icon: <TrashIcon />,
        danger: true,
        onSelect: () => setDeleting({ channel, label: dm.name }),
      });
    }
    return items;
  }

  function channelMenu(c: Channel): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    const isPinned = pinned.includes(c.channelId);
    items.push({
      label: isPinned ? "Unpin" : "Pin to the top",
      icon: isPinned ? <PinOffIcon /> : <PinIcon />,
      onSelect: () => chat.setPinned(c.channelId, !isPinned),
    });
    if (me && canEditChannel(c, me.userId, me.role)) {
      items.push({ label: "Edit channel", icon: <PencilIcon />, onSelect: () => setEditing(c) });
    }
    // Until the directory arrives, assume the creator exists (never offer it wrongly).
    const creatorKnown = Object.keys(users).length === 0 || !!users[c.createdBy];
    if (me && canDeleteChannel(c, me.userId, creatorKnown)) {
      items.push({
        label: "Delete channel",
        icon: <TrashIcon />,
        danger: true,
        onSelect: () => setDeleting({ channel: c, label: `#${c.name}` }),
      });
    }
    return items;
  }

  const iconButton = "rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink";

  const modals = (
    <>
      {editing && <EditChannelModal channel={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <DeleteChannelModal
          channel={deleting.channel}
          label={deleting.label}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );

  if (phone) {
    const phoneDmRow = (dm: DmEntry) => {
      const id = dm.userId ? dmChannelId(me.userId, dm.userId) : undefined;
      const isOnline = !!dm.userId && !!online[dm.userId];
      return (
        <PhoneRow
          key={dm.userId ?? dm.email}
          label={dm.name}
          icon={
            <span className="relative inline-flex">
              <Avatar name={dm.name} size="md" />
              <StatusBadge online={isOnline} />
            </span>
          }
          title={dm.userId ? undefined : dmTitle(dm, false)}
          unread={dm.channelId && id !== activeChannelId ? (unread[dm.channelId] ?? 0) : 0}
          urgent
          disabled={!dm.userId}
          onClick={() => dm.userId && openDm(dm.userId)}
          menu={dmMenu(dm)}
          pinned={only === "dms" && !!dm.channelId && pinnedSet.has(dm.channelId)}
        />
      );
    };
    const phoneChannelRow = (c: Channel) => (
      <PhoneRow
        key={c.channelId}
        label={c.name}
        icon={<ChannelIcon channel={c} className="text-[22px] text-ink-secondary" />}
        title={c.type === "private" ? `#${c.name} (private)` : undefined}
        unread={unread[c.channelId] ?? 0}
        urgent={!!mentioned[c.channelId]}
        onClick={() => navigate(`/app/${c.channelId}`)}
        menu={channelMenu(c)}
      />
    );
    const dmRows = (
      <>
        {/* The DMs tab lists every DM (pinned first); Home leaves pinned ones to Pinned. */}
        {(only === "dms" ? dms : shownDms).map(phoneDmRow)}
        {dms.length === 0 && (
          <li className="px-4 py-2 text-sm text-ink-secondary">
            Your team appears here once they sign in.
          </li>
        )}
        <AddRow label="Start a new message" onClick={onNewDm} />
      </>
    );
    if (only === "dms") {
      return (
        <>
          {modals}
          <ul className="py-2" aria-label="Direct messages">
            {dmRows}
          </ul>
        </>
      );
    }
    return (
      <>
        {modals}
        <nav aria-label="Channels, direct messages and apps" data-phone-lists>
          {pinnedItems.length > 0 && (
            <PhoneSectionBlock
              title="Pinned"
              icon={<PinIcon />}
              folded={folded.pinned}
              onToggle={() => toggleSection("pinned")}
            >
              {pinnedItems.map((item) =>
                item.kind === "channel" ? phoneChannelRow(item.channel) : phoneDmRow(item.dm),
              )}
            </PhoneSectionBlock>
          )}
          <PhoneSectionBlock
            title="Channels"
            icon={<HashIcon />}
            folded={folded.channels}
            onToggle={() => toggleSection("channels")}
            onOpen={onOpenSwitcher}
            openLabel="Browse channels"
          >
            {shownChannels.map(phoneChannelRow)}
            {archivedChannels.length > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  aria-expanded={showArchived}
                  className="flex w-full items-center gap-4 px-4 py-2.5 text-left text-[17px] text-ink-secondary active:bg-surface-hover"
                >
                  <span className="flex w-9 shrink-0 justify-center text-[22px]">
                    <ArchiveIcon />
                  </span>
                  <span className="flex-1">Archived ({archivedChannels.length})</span>
                  <ChevronDownIcon className={showArchived ? "rotate-180" : ""} />
                </button>
              </li>
            )}
            {showArchived &&
              archivedChannels.map((c) => (
                <PhoneRow
                  key={c.channelId}
                  label={c.name}
                  icon={<ArchiveIcon className="text-[20px] text-ink-secondary" />}
                  title={`#${c.name} (archived)`}
                  unread={0}
                  faded
                  onClick={() => navigate(`/app/${c.channelId}`)}
                />
              ))}
            <AddRow label="Add channel" onClick={onCreateChannel} />
          </PhoneSectionBlock>
          <PhoneSectionBlock
            title="Direct Messages"
            icon={<DmsIcon />}
            folded={folded.dms}
            onToggle={() => toggleSection("dms")}
            onOpen={() => navigate("/app/dms")}
            openLabel="All direct messages"
          >
            {dmRows}
          </PhoneSectionBlock>
          <PhoneSectionBlock
            title="Apps"
            icon={<AppsIcon />}
            folded={folded.apps}
            onToggle={() => toggleSection("apps")}
          >
            {PHONE_APPS.map((app) => (
              <PhoneRow
                key={app.path}
                label={app.label}
                icon={<AppTile app={app} />}
                chip="APP"
                unread={0}
                onClick={() => navigate(app.path)}
              />
            ))}
          </PhoneSectionBlock>
        </nav>
      </>
    );
  }

  const channelNavItem = (c: Channel) => (
    <NavItem
      key={c.channelId}
      compact={compact}
      label={c.name}
      icon={<ChannelIcon channel={c} />}
      title={c.type === "private" ? `#${c.name} (private)` : undefined}
      active={c.channelId === activeChannelId}
      unread={c.channelId === activeChannelId ? 0 : (unread[c.channelId] ?? 0)}
      urgent={!!mentioned[c.channelId]}
      onClick={() => navigate(`/app/${c.channelId}`)}
      menu={channelMenu(c)}
    />
  );
  const dmNavItem = (dm: DmEntry) => {
    const id = dm.userId ? dmChannelId(me.userId, dm.userId) : undefined;
    const isOnline = !!dm.userId && !!online[dm.userId];
    return (
      <NavItem
        key={dm.userId ?? dm.email}
        compact={compact}
        label={dm.name}
        icon={
          <span className="relative inline-flex">
            <Avatar name={dm.name} size={compact ? "md" : "sm"} />
            <PresenceDot online={isOnline} overlay />
          </span>
        }
        title={`${dmTitle(dm, compact)} · ${isOnline ? "Online" : "Offline"}`}
        active={id === activeChannelId}
        unread={dm.channelId && id !== activeChannelId ? (unread[dm.channelId] ?? 0) : 0}
        urgent
        disabled={!dm.userId}
        onClick={() => dm.userId && openDm(dm.userId)}
        menu={dmMenu(dm)}
      />
    );
  };

  return (
    // On the glass of the app's <aside> (Phase 37b): no background of its own.
    <div className="flex h-full flex-col">
      {modals}
      {!only && (
        <header
          className={`flex items-center border-b border-white/10 py-3 ${
            compact ? "flex-col gap-2 px-2" : "gap-3 px-4"
          }`}
        >
          <span
            className="relative"
            title={compact ? `MindfulTech · ${statusInfo.label}` : undefined}
          >
            <Logo />
            {compact && (
              <span
                className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface-sidebar ${statusInfo.dot}`}
              />
            )}
          </span>
          {!compact && (
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">MindfulTech</p>
              <p
                className="flex items-center gap-1.5 text-xs text-ink-secondary"
                aria-live="polite"
              >
                <span className={`h-2 w-2 rounded-full ${statusInfo.dot}`} />
                {statusInfo.label}
              </p>
            </div>
          )}
          <NotificationBell className={iconButton} />
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className={iconButton}
              aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
              title={`${compact ? "Expand" : "Collapse"} (Ctrl B)`}
            >
              {compact ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
            </button>
          )}
        </header>
      )}

      {!only && (
        <div className={compact ? "flex justify-center px-2 pt-3" : "px-3 pt-3"}>
          <button
            type="button"
            onClick={onOpenSwitcher}
            title={compact ? `Jump to… (${SHORTCUT})` : undefined}
            aria-label="Jump to a channel"
            className={
              compact
                ? iconButton
                : "flex w-full items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-ink-secondary hover:border-primary"
            }
          >
            <SearchIcon />
            {!compact && (
              <>
                <span className="flex-1 text-left">Jump to…</span>
                <kbd className="rounded border border-line px-1 text-[10px]">{SHORTCUT}</kbd>
              </>
            )}
          </button>
        </div>
      )}
      <nav
        className="flex-1 overflow-y-auto overflow-x-hidden pb-4"
        aria-label="Channels and direct messages"
      >
        {only !== "dms" && pinnedItems.length > 0 && (
          <Section title="Pinned" compact={compact}>
            <ul className="space-y-0.5 px-2" aria-label="Pinned conversations">
              {pinnedItems.map((item) =>
                item.kind === "channel" ? channelNavItem(item.channel) : dmNavItem(item.dm),
              )}
            </ul>
          </Section>
        )}

        {only !== "dms" && (
          <Section
            title="Channels"
            compact={compact}
            action={
              <button
                type="button"
                onClick={onCreateChannel}
                className={iconButton}
                aria-label="Create channel"
                title="Create channel"
              >
                <PlusIcon />
              </button>
            }
          >
            <ul className="space-y-0.5 px-2">{shownChannels.map(channelNavItem)}</ul>
          </Section>
        )}

        {archivedChannels.length > 0 && only !== "dms" && (
          <Section
            title="Archived"
            compact={compact}
            action={
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className={iconButton}
                aria-expanded={showArchived}
                aria-label={showArchived ? "Hide archived channels" : "Show archived channels"}
                title={showArchived ? "Hide" : `Show (${archivedChannels.length})`}
              >
                <ChevronDownIcon className={showArchived ? "rotate-180" : ""} />
              </button>
            }
          >
            {showArchived && (
              <ul className="space-y-0.5 px-2">
                {archivedChannels.map((c) => (
                  <NavItem
                    key={c.channelId}
                    compact={compact}
                    label={c.name}
                    icon={<ArchiveIcon className="text-ink-secondary" />}
                    title={`#${c.name} (archived)`}
                    active={c.channelId === activeChannelId}
                    unread={0}
                    onClick={() => navigate(`/app/${c.channelId}`)}
                  />
                ))}
              </ul>
            )}
          </Section>
        )}

        {only !== "channels" && (
          <Section
            title="Direct messages"
            compact={compact}
            action={
              <button
                type="button"
                onClick={onNewDm}
                className={iconButton}
                aria-label="New direct message"
                title="New direct message"
              >
                <PlusIcon />
              </button>
            }
          >
            <ul className="space-y-0.5 px-2">
              {shownDms.map(dmNavItem)}
              {dms.length === 0 && !compact && (
                <li className="px-2 py-1 text-xs text-ink-secondary">
                  Your team appears here once they sign in.
                </li>
              )}
            </ul>
          </Section>
        )}

        {only !== "dms" && (
          <Section title="Apps" compact={compact}>
            <ul className="space-y-0.5 px-2">
              <NavItem
                compact={compact}
                label="Task Manager"
                icon={<KanbanIcon className="text-ink-secondary" />}
                active={activeChannelId === "tasks"}
                unread={0}
                onClick={() => navigate("/app/tasks")}
              />
              <NavItem
                compact={compact}
                label="Calendar"
                icon={<CalendarIcon className="text-ink-secondary" />}
                active={activeChannelId === "calendar"}
                unread={0}
                onClick={() => navigate("/app/calendar")}
              />
              <NavItem
                compact={compact}
                label="AI Notes"
                icon={<SparklesIcon className="text-ink-secondary" />}
                active={activeChannelId === "notes"}
                unread={0}
                onClick={() => navigate("/app/notes")}
              />
              <NavItem
                compact={compact}
                label="AI News"
                icon={<NewspaperIcon className="text-ink-secondary" />}
                active={activeChannelId === "news"}
                unread={0}
                onClick={() => navigate("/app/news")}
              />
            </ul>
          </Section>
        )}
      </nav>

      {!only && (
        <footer
          className={`flex items-center gap-2 border-t border-white/10 py-3 ${
            compact ? "flex-col px-2" : "px-3"
          }`}
        >
          <button
            type="button"
            onClick={onOpenSettings}
            className={`flex min-w-0 items-center gap-2 rounded-md text-left hover:bg-surface-hover ${
              compact ? "p-1" : "flex-1 p-1"
            }`}
            title={`${myName} · Settings`}
            aria-label="Profile and settings"
          >
            <Avatar name={myName} mine size="sm" />
            {!compact && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{myName}</span>
                <span className="block truncate text-xs text-ink-secondary">{me.email}</span>
              </span>
            )}
          </button>
          {!compact && (
            <button
              type="button"
              onClick={onOpenSettings}
              className={iconButton}
              aria-label="Settings"
              title="Settings"
            >
              <SettingsIcon />
            </button>
          )}
          <button
            type="button"
            onClick={onSignOut}
            className={iconButton}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOutIcon />
          </button>
        </footer>
      )}
    </div>
  );
}
