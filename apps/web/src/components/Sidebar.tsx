import { CHANNEL_NAME_PATTERN, dmChannelId } from "@mindfultech/shared";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { dmEntries, displayName, normalizeChannelName } from "../lib/channels";
import type { WsStatus } from "../lib/ws";
import { selectUnread, useChat } from "../store";
import { Avatar } from "./Avatar";
import { Logo } from "./LoginPage";
import { HashIcon, LogOutIcon, PlusIcon, SearchIcon } from "./icons";

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘ K" : "Ctrl K";

const STATUS: Record<WsStatus, { dot: string; label: string }> = {
  idle: { dot: "bg-warning", label: "Conectando…" },
  connecting: { dot: "bg-warning", label: "Conectando…" },
  open: { dot: "bg-success", label: "Conectado" },
  reconnecting: { dot: "bg-warning", label: "Reconectando…" },
  closed: { dot: "bg-error", label: "Desconectado" },
};

function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto rounded-full bg-sky px-2 py-0.5 text-xs font-semibold text-ink">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavItem({
  active,
  unread,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  unread: number;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
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
        title={title}
        aria-current={active ? "page" : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
      >
        {children}
        <UnreadBadge count={unread} />
      </button>
    </li>
  );
}

function CreateChannelForm({ onDone }: { onDone: (channelId?: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = normalizeChannelName(value);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!CHANNEL_NAME_PATTERN.test(name)) {
      setError("Usa letras minúsculas, números o guiones (máx. 32).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await chat.createChannel(name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el canal.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-1.5 px-2 pb-2">
      <input
        autoFocus
        className="input py-1.5"
        placeholder="nombre-del-canal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        aria-label="Nombre del canal"
        disabled={busy}
      />
      {value && name !== value && <p className="text-xs text-ink-secondary">Se creará #{name}</p>}
      {error && <p className="text-xs text-ink">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary px-3 py-1 text-xs" disabled={busy || !name}>
          {busy ? "Creando…" : "Crear"}
        </button>
        <button
          type="button"
          className="rounded-lg px-3 py-1 text-xs text-ink-secondary hover:bg-surface-hover"
          onClick={() => onDone()}
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-4">
      <div className="flex items-center justify-between px-4 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

interface SidebarProps {
  activeChannelId: string;
  onOpenSwitcher: () => void;
  onSignOut: () => void;
}

export function Sidebar({ activeChannelId, onOpenSwitcher, onSignOut }: SidebarProps) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { me, status, channels, team, directory } = useChat(
    useShallow((s) => ({
      me: s.me,
      status: s.status,
      channels: s.channels,
      team: s.team,
      directory: s.directory,
    })),
  );
  const unread = useChat(
    useShallow((s) =>
      Object.fromEntries(s.channels.map((c) => [c.channelId, selectUnread(s, c.channelId)])),
    ),
  );

  const publicChannels = useMemo(
    () =>
      channels
        .filter((c) => c.type === "public")
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
    () => (me ? dmEntries(team, channels, me, directory, (id) => dmChannelId(me.userId, id)) : []),
    [team, channels, me, directory],
  );

  if (!me) return null;
  const statusInfo = STATUS[status];

  function openDm(userId: string) {
    const id = chat.openDm(userId);
    if (id) navigate(`/app/${id}`);
  }

  return (
    <div className="flex h-full flex-col border-r border-line bg-surface-sidebar">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Logo />
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">MindfulTech</p>
          <p className="flex items-center gap-1.5 text-xs text-ink-secondary" aria-live="polite">
            <span className={`h-2 w-2 rounded-full ${statusInfo.dot}`} />
            {statusInfo.label}
          </p>
        </div>
      </header>

      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onOpenSwitcher}
          className="flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-secondary hover:border-primary"
        >
          <SearchIcon />
          <span className="flex-1 text-left">Ir a…</span>
          <kbd className="rounded border border-line px-1 text-[10px]">{SHORTCUT}</kbd>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto pb-4" aria-label="Canales y mensajes directos">
        <Section
          title="Canales"
          action={
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="rounded p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
              aria-label="Crear canal"
              title="Crear canal"
            >
              <PlusIcon />
            </button>
          }
        >
          {creating && (
            <CreateChannelForm
              onDone={(channelId) => {
                setCreating(false);
                if (channelId) navigate(`/app/${channelId}`);
              }}
            />
          )}
          <ul className="space-y-0.5 px-2">
            {publicChannels.map((c) => (
              <NavItem
                key={c.channelId}
                active={c.channelId === activeChannelId}
                unread={c.channelId === activeChannelId ? 0 : (unread[c.channelId] ?? 0)}
                onClick={() => navigate(`/app/${c.channelId}`)}
              >
                <HashIcon className="shrink-0 text-ink-secondary" />
                <span className="truncate">{c.name}</span>
              </NavItem>
            ))}
          </ul>
        </Section>

        <Section title="Mensajes directos">
          <ul className="space-y-0.5 px-2">
            {dms.map((dm) => {
              const id = dm.userId ? dmChannelId(me.userId, dm.userId) : undefined;
              return (
                <NavItem
                  key={dm.email}
                  active={id === activeChannelId}
                  unread={dm.channelId && id !== activeChannelId ? (unread[dm.channelId] ?? 0) : 0}
                  disabled={!dm.userId}
                  title={
                    dm.userId ? undefined : "Falta el id de Cognito de esta persona en VITE_USERS"
                  }
                  onClick={() => dm.userId && openDm(dm.userId)}
                >
                  <Avatar email={dm.email} size="sm" />
                  <span className="truncate">{displayName(dm.email)}</span>
                </NavItem>
              );
            })}
            {dms.length === 0 && (
              <li className="px-2 py-1 text-xs text-ink-secondary">
                Configura VITE_USERS para ver al equipo.
              </li>
            )}
          </ul>
        </Section>
      </nav>

      <footer className="flex items-center gap-2 border-t border-line px-3 py-3">
        <Avatar email={me.email} mine size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={me.email}>
          {me.email}
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
        >
          <LogOutIcon />
        </button>
      </footer>
    </div>
  );
}
