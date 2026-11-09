import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useMatch, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { signOut } from "../lib/auth";
import { chat } from "../lib/chat";
import { orderChannels } from "../lib/channels";
import { signOutPush, syncPush } from "../lib/push";
import { tasksApiConfigured } from "../lib/tasksApi";
import { selectUnread, useChat } from "../store";
import { useTasks } from "../store/tasks";
import { ChannelIcon } from "./ChannelIcon";
import { ChannelView } from "./ChannelView";
import { CloseIcon, KanbanIcon, LockIcon, LogOutIcon, MenuIcon } from "./icons";
import { Logo } from "./LoginPage";
import { NotificationBell } from "./NotificationBell";
import { PushPrompt } from "./PushPrompt";
import { Toast } from "./Toast";

const TaskManager = lazy(() => import("./TaskManager").then((m) => ({ default: m.TaskManager })));
const PasswordModal = lazy(() =>
  Promise.all([import("./Modal"), import("./ChangePasswordForm")]).then(([m, f]) => ({
    default: ({ onClose }: Readonly<{ onClose: () => void }>) => (
      <m.Modal title="Change password" onClose={onClose}>
        <f.ChangePasswordForm />
      </m.Modal>
    ),
  })),
);

const iconButton = "rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink";

/**
 * Where a guest goes: their boards and (Phase 55) the private channels they
 * were invited to. The list comes from the server, which only ever sends a
 * guest their own channels.
 */
function GuestNav({
  activeChannelId,
  onBoards,
  boardsActive,
  hasBoards,
  onNavigate,
}: Readonly<{
  activeChannelId: string | null;
  boardsActive: boolean;
  /** Only someone invited to a board sees Boards: a channel's external sees its chat only. */
  hasBoards: boolean;
  onBoards: () => void;
  onNavigate: (channelId: string) => void;
}>) {
  const channels = useChat((s) => s.channels);
  const shown = useMemo(
    () => orderChannels(channels.filter((c) => c.type === "private" && !c.archived)),
    [channels],
  );
  const unread = useChat(
    useShallow((s) =>
      Object.fromEntries(s.channels.map((c) => [c.channelId, selectUnread(s, c.channelId)])),
    ),
  );
  const row = (active: boolean) =>
    `flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm ${
      active ? "bg-primary/15 font-semibold text-ink" : "text-ink-secondary hover:bg-surface-hover"
    }`;
  return (
    <nav className="flex flex-col gap-4 p-3" aria-label="Your channels and boards">
      {shown.length > 0 && (
        <div>
          <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            Channels
          </p>
          <ul className="space-y-0.5">
            {shown.map((c) => {
              const count = c.channelId === activeChannelId ? 0 : (unread[c.channelId] ?? 0);
              return (
                <li key={c.channelId}>
                  <button
                    type="button"
                    onClick={() => onNavigate(c.channelId)}
                    className={row(c.channelId === activeChannelId)}
                    aria-current={c.channelId === activeChannelId ? "page" : undefined}
                  >
                    <ChannelIcon channel={c} />
                    <span
                      className={`min-w-0 flex-1 truncate ${count ? "font-semibold text-ink" : ""}`}
                    >
                      {c.name}
                    </span>
                    {count > 0 && (
                      <span className="rounded-full bg-error px-1.5 text-[11px] font-semibold leading-5 text-on-accent">
                        {count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {hasBoards && (
        <div>
          <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            Boards
          </p>
          <button
            type="button"
            onClick={onBoards}
            className={row(boardsActive)}
            aria-current={boardsActive ? "page" : undefined}
          >
            <KanbanIcon /> <span className="flex-1">Your boards</span>
          </button>
        </div>
      )}
    </nav>
  );
}

/**
 * What a guest (an external: a client, a partner) sees: the boards they were
 * invited to and, since Phase 55, the private channels they were invited to,
 * and nothing else of the team's — no other channels, DMs, calls, calendar,
 * Vault or settings (except their own password). The server enforces the same
 * (route guards, `canSeeChannel` and the delivery filter); this is only the
 * matching UI.
 */
export function GuestLayout({ wsUrl }: Readonly<{ wsUrl: string }>) {
  const navigate = useNavigate();
  const tasksMatch = useMatch("/app/tasks/:boardId?");
  const threadMatch = useMatch("/app/:channelId/thread/:messageId");
  const channelMatch = useMatch("/app/:channelId");
  const boardId = tasksMatch?.params.boardId;
  const channelId = tasksMatch
    ? null
    : (threadMatch?.params.channelId ?? channelMatch?.params.channelId ?? null);
  const threadId = threadMatch?.params.messageId;
  const me = useChat((s) => s.me);
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const firstChannel = useChat(
    (s) =>
      orderChannels(s.channels.filter((c) => c.type === "private" && !c.archived))[0]?.channelId,
  );
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Phase 55: boards only for someone invited to one (an external of a channel has its chat only).
  const boardsLoaded = useTasks((s) => s.boardsLoaded);
  const hasBoards = useTasks((s) => s.boards.length > 0);
  useEffect(() => {
    if (tasksApiConfigured()) void useTasks.getState().loadBoards();
    else useTasks.setState({ boardsLoaded: true });
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOutPush();
    chat.stop();
    useTasks.getState().reset();
    await signOut().catch(() => {});
    useChat.getState().setSession(null);
  }, []);

  // The socket carries their channels' messages, live board updates and the names they may see.
  useEffect(() => {
    chat.start(wsUrl, () => {
      useChat.getState().showToast("Your session expired. Please sign in again.");
      void handleSignOut();
    });
    return () => chat.stop();
  }, [wsUrl, handleSignOut]);

  useEffect(() => {
    if (me) void syncPush(me.userId);
  }, [me]);

  // Opening a channel: its history once, and marked read (as for the team).
  useEffect(() => {
    const s = useChat.getState();
    s.setActiveChannel(channelId ?? "");
    setNavOpen(false);
    if (!channelId) return;
    if (!(channelId in s.cursors) || s.stale[channelId]) chat.loadHistory(channelId, "initial");
    s.setListAtBottom(true);
    chat.viewed(channelId);
  }, [channelId]);

  // A notification clicked while the app is open: the service worker asks us to go there.
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent<{ type?: string; path?: string }>) => {
      const path = e.data?.path;
      if (e.data?.type === "navigate" && typeof path === "string" && path.startsWith("/app/")) {
        navigate(path);
      }
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, [navigate]);

  useEffect(() => {
    document.title = "MindfulTech";
  }, []);

  const openThread = useCallback(
    (m: { messageId: string; channelId: string }) =>
      navigate(`/app/${encodeURIComponent(m.channelId)}/thread/${encodeURIComponent(m.messageId)}`),
    [navigate],
  );
  const closeThread = useCallback(
    () => channelId && navigate(`/app/${encodeURIComponent(channelId)}`),
    [navigate, channelId],
  );

  // `/app`: their first channel, else their boards; with neither, a note.
  if (!tasksMatch && !channelId) {
    if (!channelsLoaded || (!firstChannel && !boardsLoaded)) {
      return <div className="h-full bg-surface" aria-busy="true" aria-label="Loading" />;
    }
    if (firstChannel) return <Navigate to={`/app/${firstChannel}`} replace />;
    if (hasBoards) return <Navigate to="/app/tasks" replace />;
  }
  // The Task Manager is only for someone with a board.
  if (tasksMatch && boardsLoaded && !hasBoards) {
    return <Navigate to={firstChannel ? `/app/${firstChannel}` : "/app"} replace />;
  }

  const nav = (
    <GuestNav
      activeChannelId={channelId}
      boardsActive={!!tasksMatch}
      hasBoards={hasBoards}
      onBoards={() => navigate("/app/tasks")}
      onNavigate={(id) => navigate(`/app/${encodeURIComponent(id)}`)}
    />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface pb-[env(safe-area-inset-bottom)]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface-sidebar px-3 pt-[env(safe-area-inset-top)] sm:px-4">
        {/* In a channel its own header has the menu button (phones). */}
        {!channelId && (
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className={`${iconButton} md:hidden`}
            aria-label="Your channels and boards"
          >
            <MenuIcon />
          </button>
        )}
        <Logo />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">MindfulTech</p>
          <p className="truncate text-xs text-ink-secondary">Guest access · {me?.email}</p>
        </div>
        <NotificationBell className={iconButton} />
        <button
          type="button"
          onClick={() => setPasswordOpen(true)}
          className={iconButton}
          aria-label="Change password"
          title="Change password"
        >
          <LockIcon />
        </button>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className={iconButton}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOutIcon />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-line bg-surface-sidebar md:block">
          {nav}
        </aside>
        {navOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true">
            <button
              type="button"
              className="absolute inset-0 bg-black/50"
              aria-label="Close"
              onClick={() => setNavOpen(false)}
            />
            <div className="relative flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-surface-sidebar pt-[env(safe-area-inset-top)]">
              <div className="flex items-center justify-between px-4 pt-3">
                <p className="font-semibold text-ink">MindfulTech</p>
                <button
                  type="button"
                  onClick={() => setNavOpen(false)}
                  className={iconButton}
                  aria-label="Close"
                >
                  <CloseIcon />
                </button>
              </div>
              {nav}
            </div>
          </div>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <PushPrompt />
          {!channelId && !tasksMatch ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="font-semibold text-ink">Nothing is shared with you yet</p>
              <p className="max-w-sm text-sm text-ink-secondary">
                When the MindfulTech team invites you to a channel, it shows up here.
              </p>
            </div>
          ) : channelId ? (
            <ChannelView
              channelId={channelId}
              onOpenSidebar={() => setNavOpen(true)}
              threadId={threadId}
              onOpenThread={openThread}
              onCloseThread={closeThread}
            />
          ) : (
            <Suspense
              fallback={<div className="flex-1" aria-busy="true" aria-label="Loading boards" />}
            >
              <TaskManager boardId={boardId} />
            </Suspense>
          )}
        </main>
      </div>
      {passwordOpen && (
        <Suspense fallback={null}>
          <PasswordModal onClose={() => setPasswordOpen(false)} />
        </Suspense>
      )}
      <Toast />
    </div>
  );
}
