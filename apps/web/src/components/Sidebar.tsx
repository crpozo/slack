import {
  canDeleteChannel,
  canEditChannel,
  dmChannelId,
  GENERAL_CHANNEL_ID,
  MAX_UNREAD_COUNT,
  type Channel,
} from "@mindfultech/shared";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { dmEntries, pinnedFirst, type DmEntry } from "../lib/channels";
import type { WsStatus } from "../lib/ws";
import { selectUnread, useChat, useNameOf } from "../store";
import { Avatar, PresenceDot } from "./Avatar";
import { DeleteChannelModal, EditChannelModal } from "./ChannelModals";
import { NotificationBell } from "./NotificationBell";
import { Popover } from "./Popover";
import {
  HashIcon,
  KanbanIcon,
  LockIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
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
            className="w-52 rounded-xl border border-line bg-surface-raised p-1 shadow-xl"
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

/** `#general` first, then alphabetical. */
function generalFirst(a: Channel, b: Channel): number {
  if (a.channelId === GENERAL_CHANNEL_ID) return -1;
  if (b.channelId === GENERAL_CHANNEL_ID) return 1;
  return a.name.localeCompare(b.name);
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
    <li className="group relative">
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
    <section className={compact ? "mt-3 border-t border-line pt-3 first:border-0" : "mt-4"}>
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

const channelIcon = (c: Channel) =>
  c.type === "private" ? (
    <LockIcon className="text-ink-secondary" aria-label="Private" />
  ) : (
    <HashIcon className="text-ink-secondary" />
  );

interface SidebarProps {
  activeChannelId: string;
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

  const namedChannels = useMemo(
    () => channels.filter((c) => c.type !== "dm").sort(generalFirst),
    [channels],
  );
  const dms = useMemo(
    () =>
      me
        ? pinnedFirst(
            dmEntries(team, channels, me, directory, (id) => dmChannelId(me.userId, id), users),
            pinned,
          )
        : [],
    [team, channels, me, directory, users, pinned],
  );

  if (!me) return null;
  const statusInfo = STATUS[status];
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
        label: isPinned ? "Unpin chat" : "Pin chat",
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

  return (
    <div className="flex h-full flex-col border-r border-line bg-surface-sidebar">
      {editing && <EditChannelModal channel={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <DeleteChannelModal
          channel={deleting.channel}
          label={deleting.label}
          onClose={() => setDeleting(null)}
        />
      )}
      <header
        className={`flex items-center border-b border-line py-3 ${
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
            <p className="flex items-center gap-1.5 text-xs text-ink-secondary" aria-live="polite">
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

      <div className={compact ? "flex justify-center px-2 pt-3" : "px-3 pt-3"}>
        <button
          type="button"
          onClick={onOpenSwitcher}
          title={compact ? `Jump to… (${SHORTCUT})` : undefined}
          aria-label="Jump to a channel"
          className={
            compact
              ? iconButton
              : "flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-secondary hover:border-primary"
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

      <nav
        className="flex-1 overflow-y-auto overflow-x-hidden pb-4"
        aria-label="Channels and direct messages"
      >
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
          <ul className="space-y-0.5 px-2">
            {namedChannels.map((c) => (
              <NavItem
                key={c.channelId}
                compact={compact}
                label={c.name}
                icon={channelIcon(c)}
                title={c.type === "private" ? `#${c.name} (private)` : undefined}
                active={c.channelId === activeChannelId}
                unread={c.channelId === activeChannelId ? 0 : (unread[c.channelId] ?? 0)}
                urgent={!!mentioned[c.channelId]}
                onClick={() => navigate(`/app/${c.channelId}`)}
                menu={channelMenu(c)}
              />
            ))}
          </ul>
        </Section>

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
            {dms.map((dm) => {
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
                  pinned={!!dm.channelId && pinned.includes(dm.channelId)}
                />
              );
            })}
            {dms.length === 0 && !compact && (
              <li className="px-2 py-1 text-xs text-ink-secondary">
                Your team appears here once they sign in.
              </li>
            )}
          </ul>
        </Section>

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
          </ul>
        </Section>
      </nav>

      <footer
        className={`flex items-center gap-2 border-t border-line py-3 ${
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
          aria-label="Profile and theme settings"
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
    </div>
  );
}
