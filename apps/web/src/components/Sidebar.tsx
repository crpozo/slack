import { dmChannelId, type Channel } from "@mindfultech/shared";
import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { dmEntries } from "../lib/channels";
import type { WsStatus } from "../lib/ws";
import { selectUnread, useChat, useNameOf } from "../store";
import { Avatar } from "./Avatar";
import {
  HashIcon,
  LockIcon,
  LogOutIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "./icons";
import { Logo } from "./LoginPage";

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘ K" : "Ctrl K";

const STATUS: Record<WsStatus, { dot: string; label: string }> = {
  idle: { dot: "bg-warning", label: "Conectando…" },
  connecting: { dot: "bg-warning", label: "Conectando…" },
  open: { dot: "bg-success", label: "Conectado" },
  reconnecting: { dot: "bg-warning", label: "Reconectando…" },
  closed: { dot: "bg-error", label: "Desconectado" },
};

function UnreadBadge({ count, compact }: { count: number; compact: boolean }) {
  if (count === 0) return null;
  if (compact) {
    return (
      <span
        className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-surface-sidebar bg-sky"
        aria-label={`${count} sin leer`}
      />
    );
  }
  return (
    <span className="ml-auto rounded-full bg-sky px-2 py-0.5 text-xs font-semibold text-on-accent">
      {count > 99 ? "99+" : count}
    </span>
  );
}

interface NavItemProps {
  active: boolean;
  unread: number;
  compact: boolean;
  /** Visible text, and the tooltip in compact mode. */
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

function NavItem({ active, unread, compact, label, icon, disabled, title, onClick }: NavItemProps) {
  const tone = active
    ? "bg-primary/20 font-semibold text-ink"
    : unread > 0
      ? "font-semibold text-ink hover:bg-surface-hover"
      : "text-ink-secondary hover:bg-surface-hover hover:text-ink";
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title ?? (compact ? label : undefined)}
        aria-label={compact ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={`relative flex w-full items-center gap-2 rounded-md text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? "h-10 justify-center px-0" : "px-2 py-1.5"
        } ${tone}`}
      >
        <span className="flex shrink-0 items-center justify-center">{icon}</span>
        {!compact && <span className="truncate">{label}</span>}
        <UnreadBadge count={unread} compact={compact} />
      </button>
    </li>
  );
}

function Section({
  title,
  action,
  compact,
  children,
}: {
  title: string;
  action?: ReactNode;
  compact: boolean;
  children: ReactNode;
}) {
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
    <LockIcon className="text-ink-secondary" aria-label="Privado" />
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
  onOpenSettings: () => void;
  onSignOut: () => void;
}

export function Sidebar({
  activeChannelId,
  collapsed,
  onToggleCollapsed,
  onOpenSwitcher,
  onCreateChannel,
  onOpenSettings,
  onSignOut,
}: SidebarProps) {
  const navigate = useNavigate();
  const nameOf = useNameOf();
  const { me, status, channels, team, directory, users } = useChat(
    useShallow((s) => ({
      me: s.me,
      status: s.status,
      channels: s.channels,
      team: s.team,
      directory: s.directory,
      users: s.users,
    })),
  );
  const unread = useChat(
    useShallow((s) =>
      Object.fromEntries(s.channels.map((c) => [c.channelId, selectUnread(s, c.channelId)])),
    ),
  );

  const namedChannels = useMemo(
    () =>
      channels
        .filter((c) => c.type !== "dm")
        .sort((a, b) =>
          a.channelId === "ch_general"
            ? -1
            : b.channelId === "ch_general"
              ? 1
              : a.name.localeCompare(b.name),
        ),
    [channels],
  );
  const dms = useMemo(
    () =>
      me ? dmEntries(team, channels, me, directory, (id) => dmChannelId(me.userId, id), users) : [],
    [team, channels, me, directory, users],
  );

  if (!me) return null;
  const statusInfo = STATUS[status];
  const myName = nameOf(me.userId, me.email);
  const compact = collapsed;

  function openDm(userId: string) {
    const id = chat.openDm(userId);
    if (id) navigate(`/app/${id}`);
  }

  const iconButton = "rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink";

  return (
    <div className="flex h-full flex-col border-r border-line bg-surface-sidebar">
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
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={iconButton}
            aria-label={compact ? "Expandir barra lateral" : "Contraer barra lateral"}
            title={`${compact ? "Expandir" : "Contraer"} (Ctrl B)`}
          >
            {compact ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </button>
        )}
      </header>

      <div className={compact ? "flex justify-center px-2 pt-3" : "px-3 pt-3"}>
        <button
          type="button"
          onClick={onOpenSwitcher}
          title={compact ? `Ir a… (${SHORTCUT})` : undefined}
          aria-label="Ir a un canal"
          className={
            compact
              ? iconButton
              : "flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-secondary hover:border-primary"
          }
        >
          <SearchIcon />
          {!compact && (
            <>
              <span className="flex-1 text-left">Ir a…</span>
              <kbd className="rounded border border-line px-1 text-[10px]">{SHORTCUT}</kbd>
            </>
          )}
        </button>
      </div>

      <nav
        className="flex-1 overflow-y-auto overflow-x-hidden pb-4"
        aria-label="Canales y mensajes directos"
      >
        <Section
          title="Canales"
          compact={compact}
          action={
            <button
              type="button"
              onClick={onCreateChannel}
              className={iconButton}
              aria-label="Crear canal"
              title="Crear canal"
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
                title={c.type === "private" ? `#${c.name} (privado)` : undefined}
                active={c.channelId === activeChannelId}
                unread={c.channelId === activeChannelId ? 0 : (unread[c.channelId] ?? 0)}
                onClick={() => navigate(`/app/${c.channelId}`)}
              />
            ))}
          </ul>
        </Section>

        <Section title="Mensajes directos" compact={compact}>
          <ul className="space-y-0.5 px-2">
            {dms.map((dm) => {
              const id = dm.userId ? dmChannelId(me.userId, dm.userId) : undefined;
              return (
                <NavItem
                  key={dm.userId ?? dm.email}
                  compact={compact}
                  label={dm.name}
                  icon={<Avatar name={dm.name} size={compact ? "md" : "sm"} />}
                  title={
                    dm.userId
                      ? compact
                        ? dm.name
                        : dm.email
                      : "Esta persona aún no ha iniciado sesión"
                  }
                  active={id === activeChannelId}
                  unread={dm.channelId && id !== activeChannelId ? (unread[dm.channelId] ?? 0) : 0}
                  disabled={!dm.userId}
                  onClick={() => dm.userId && openDm(dm.userId)}
                />
              );
            })}
            {dms.length === 0 && !compact && (
              <li className="px-2 py-1 text-xs text-ink-secondary">
                Aquí aparecerá el equipo cuando inicie sesión.
              </li>
            )}
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
          title={`${myName} · Ajustes`}
          aria-label="Ajustes de perfil y tema"
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
            aria-label="Ajustes"
            title="Ajustes"
          >
            <SettingsIcon />
          </button>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className={iconButton}
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
        >
          <LogOutIcon />
        </button>
      </footer>
    </div>
  );
}
