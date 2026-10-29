import { GENERAL_CHANNEL_ID, isDmChannel } from "@mindfultech/shared";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocation, useMatch, useNavigate, useParams } from "react-router-dom";
import { signOut } from "../lib/auth";
import { retryPushSyncIfFailed, signOutPush, syncPush } from "../lib/push";
import { chat } from "../lib/chat";
import { useEdgeSwipe } from "../lib/gestures";
import { dmPeer } from "../lib/channels";
import {
  clampSidebarWidth,
  loadSidebarPrefs,
  saveSidebarPrefs,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  type SidebarPrefs,
} from "../lib/sidebar";
import { selectUnread, useChat } from "../store";
import { useTasks } from "../store/tasks";
import { DESKTOP_QUERY, useMediaQuery, useSoftKeyboard } from "../lib/hooks";
import { forgetRecents, recordVisit } from "../lib/recents";
import { forgetPersisted, startPersistence } from "../lib/persist";
import { saveSessionSnapshot } from "../lib/session";
import {
  ActivityScreen,
  BottomTabs,
  CreateSheet,
  Fab,
  HuddlesSheet,
  MobileHomeHeader,
  MobileScreen,
  MoreSheet,
  NewTaskSheet,
  RecentsSheet,
  SearchScreen,
  ShortcutCards,
} from "./MobileScreens";
import { useCalendar } from "../store/calendar";
import { useNews } from "../store/news";
import { useNotesHub } from "../store/notesHub";
import { CreateChannelModal, NewDmModal } from "./ChannelModals";
import { CallLayer } from "./CallLayer";
import { GroupCallLayer } from "./GroupCall";
import { PushPrompt } from "./PushPrompt";
import { ChannelView } from "./ChannelView";
import { ViewBoundary } from "./ViewBoundary";
import { PlusIcon } from "./icons";

// Not needed to show a conversation: loaded on first use, off the initial bundle.
const TaskManager = lazy(() => import("./TaskManager").then((m) => ({ default: m.TaskManager })));
const CalendarView = lazy(() =>
  import("./CalendarView").then((m) => ({ default: m.CalendarView })),
);
const NotesHub = lazy(() => import("./NotesHub").then((m) => ({ default: m.NotesHub })));
const NewsView = lazy(() => import("./NewsView").then((m) => ({ default: m.NewsView })));
const SkillsView = lazy(() => import("./SkillsView").then((m) => ({ default: m.SkillsView })));
const SettingsModal = lazy(() =>
  import("./SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
const OmniSearch = lazy(() => import("./OmniSearch").then((m) => ({ default: m.OmniSearch })));
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";

const BASE_TITLE = "MindfulTech Slack";

/** Phones: the bottom sheets the shell opens. */
type MobileSheet = "more" | "create" | "task" | "recents" | "huddles" | null;

export function ChatLayout({ wsUrl }: Readonly<{ wsUrl: string }>) {
  const params = useParams();
  const { pathname } = useLocation();
  // `/app/tasks[/:boardId]` swaps the chat column for the Task Manager; no channel is active.
  const tasksMatch = useMatch("/app/tasks/:boardId?");
  // `/app/calendar` likewise shows the company calendar.
  const calendarMatch = useMatch("/app/calendar");
  // `/app/notes`: the AI Notes hub (Phase 29).
  const notesMatch = useMatch("/app/notes");
  // `/app/news`: AI News (Phase 35b).
  const newsMatch = useMatch("/app/news");
  // `/app/skills`: AI Skills (Phase 44).
  const skillsMatch = useMatch("/app/skills");
  const navigate = useNavigate();
  // Phones' tabs and a thread's own screen are routes too.
  const threadMatch = useMatch("/app/:channelId/thread/:messageId");
  const homeMatch = useMatch("/app/home");
  const dmsMatch = useMatch("/app/dms");
  const activityMatch = useMatch("/app/activity");
  const searchMatch = useMatch("/app/search");
  const tab = homeMatch
    ? "home"
    : dmsMatch
      ? "dms"
      : activityMatch
        ? "activity"
        : searchMatch
          ? "search"
          : null;
  const channelId =
    tasksMatch || calendarMatch || notesMatch || newsMatch || skillsMatch || tab
      ? null
      : (threadMatch?.params.channelId ?? params.channelId ?? GENERAL_CHANNEL_ID);
  const threadId = threadMatch?.params.messageId;
  const openThread = useCallback(
    (m: { messageId: string; channelId: string }) =>
      navigate(`/app/${encodeURIComponent(m.channelId)}/thread/${encodeURIComponent(m.messageId)}`),
    [navigate],
  );
  const closeThread = useCallback(
    () => channelId && navigate(`/app/${encodeURIComponent(channelId)}`),
    [navigate, channelId],
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  // Phones: which sheet is up (the FAB's, More, recent conversations…), and the keyboard.
  const [sheet, setSheet] = useState<MobileSheet>(null);
  const keyboardUp = useSoftKeyboard();

  // Desktop sidebar: resizable width + icon-only mode, both remembered.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [sidebar, setSidebar] = useState<SidebarPrefs>(loadSidebarPrefs);
  const [resizing, setResizing] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const updateSidebar = useCallback((patch: Partial<SidebarPrefs>) => {
    setSidebar((prev) => {
      const next = { ...prev, ...patch };
      saveSidebarPrefs(next);
      return next;
    });
  }, []);
  const toggleCollapsed = useCallback(
    () => updateSidebar({ collapsed: !sidebar.collapsed }),
    [sidebar.collapsed, updateSidebar],
  );
  const collapsed = isDesktop && sidebar.collapsed;
  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebar.width;

  // Phones: swipe in from the left edge to open the drawer, swipe it left to close.
  const drawerWidth = Math.min(288, Math.round(window.innerWidth * 0.85));
  const openDrawer = useCallback(() => setSidebarOpen(true), []);
  const closeDrawer = useCallback(() => setSidebarOpen(false), []);
  const drag = useEdgeSwipe({
    enabled: false, // phones use the tab bar now; the drawer is never shown
    open: sidebarOpen,
    width: drawerWidth,
    onOpen: openDrawer,
    onClose: closeDrawer,
  });
  let drawerStyle: React.CSSProperties | undefined;
  if (isDesktop) drawerStyle = { width: sidebarWidth };
  else if (drag !== null) {
    drawerStyle = { transform: `translateX(${(drag - 1) * drawerWidth}px)`, transition: "none" };
  }

  function onResizeStart(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, width: sidebar.width };
    setResizing(true);
  }
  function onResizeMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current) return;
    const width = clampSidebarWidth(dragStart.current.width + e.clientX - dragStart.current.x);
    setSidebar((prev) => ({ ...prev, width }));
  }
  function onResizeEnd() {
    if (!dragStart.current) return;
    dragStart.current = null;
    setResizing(false);
    updateSidebar({});
  }
  function onResizeKey(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") updateSidebar({ width: clampSidebarWidth(sidebar.width - step) });
    else if (e.key === "ArrowRight")
      updateSidebar({ width: clampSidebarWidth(sidebar.width + step) });
    else return;
    e.preventDefault();
  }

  const handleSignOut = useCallback(async () => {
    // While the token still works: stop this device's pushes for this account.
    await signOutPush();
    chat.stop();
    useTasks.getState().reset();
    useCalendar.getState().reset();
    useNotesHub.getState().reset();
    useNews.getState().reset();
    const userId = useChat.getState().me?.userId;
    if (userId) {
      await forgetPersisted(userId);
      forgetRecents(userId);
    }
    saveSessionSnapshot(null);
    await signOut().catch(() => {});
    useChat.getState().setSession(null);
  }, []);

  // One WebSocket for the whole signed-in session. (Declared first: effects run in order.)
  useEffect(() => {
    chat.start(wsUrl, () => {
      useChat.getState().showToast("Your session expired. Please sign in again.");
      void handleSignOut();
    });
    return () => chat.stop();
  }, [wsUrl, handleSignOut]);

  // Offline cache: paint from the last snapshot, keep it current (see lib/persist).
  const meId = useChat((s) => s.me?.userId);
  useEffect(() => {
    if (!meId) return;
    return startPersistence(meId);
  }, [meId]);

  // Web Push: keep this device's subscription current (never prompts by itself).
  useEffect(() => {
    if (meId) void syncPush(meId);
  }, [meId]);

  // A notification was clicked while the app was open: the service worker asks us to navigate.
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent<{ type?: string; path?: string }>) => {
      const path = e.data?.path;
      if (e.data?.type === "navigate" && typeof path === "string" && path.startsWith("/app/")) {
        navigate(path);
      } else if (e.data?.type === "push.resubscribed") {
        // The push service rotated this device's subscription: the server needs the new one.
        const meId = useChat.getState().me?.userId;
        if (meId) void syncPush(meId);
      }
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, [navigate]);

  // Switching channels: load its history once and mark it read.
  useEffect(() => {
    const s = useChat.getState();
    s.setActiveChannel(channelId);
    setSidebarOpen(false);
    setSheet(null);
    if (!channelId) return;
    if (s.me) recordVisit(s.me.userId, channelId);
    if (!(channelId in s.cursors) || s.stale[channelId]) chat.loadHistory(channelId, "initial");
    s.setListAtBottom(true);
    chat.viewed(channelId);
  }, [channelId]);

  // The channel or DM on screen was deleted (by anyone): back to #general. This runs
  // before the store forgets it, so the DM auto-create below never re-opens it.
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  useEffect(
    () =>
      chat.onChannelDeleted((deletedId, by) => {
        if (deletedId !== channelIdRef.current) return;
        navigate(`/app/${GENERAL_CHANNEL_ID}`, { replace: true });
        if (by !== useChat.getState().me?.userId) {
          useChat.getState().showToast("This conversation was deleted.");
        }
      }),
    [navigate],
  );

  // A DM link for a conversation that doesn't exist yet: create it.
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const channelExists = useChat((s) => s.channels.some((c) => c.channelId === channelId));
  const myUserId = useChat((s) => s.me?.userId);
  useEffect(() => {
    if (!channelId || !channelsLoaded || channelExists || !myUserId || !isDmChannel(channelId))
      return;
    const peer = dmPeer(channelId, myUserId);
    if (peer) chat.openDm(peer);
  }, [channelId, channelsLoaded, channelExists, myUserId]);

  // Back to the window: what's on screen counts as read.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      const s = useChat.getState();
      if (channelId) chat.viewed(channelId);
      // A push sync that failed at sign-in (push service hiccup) gets another go.
      if (s.me) retryPushSyncIfFailed(s.me.userId);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [channelId]);

  // Ctrl/Cmd + K omni-search (messages, channels, people), Ctrl/Cmd + B collapse the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setSwitcherOpen((open) => !open);
      } else if (key === "b" && isDesktop) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, toggleCollapsed]);

  // Unread total in the tab title.
  const totalUnread = useChat((s) =>
    s.channels.reduce(
      (sum, c) => sum + (c.channelId === channelId ? 0 : selectUnread(s, c.channelId)),
      0,
    ),
  );
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${BASE_TITLE}` : BASE_TITLE;
  }, [totalUnread]);

  const overlays = (
    <>
      <CallLayer />
      <GroupCallLayer />
      <Suspense fallback={null}>
        {switcherOpen && <OmniSearch onClose={() => setSwitcherOpen(false)} />}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </Suspense>
      {createOpen && (
        <CreateChannelModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate(`/app/${id}`);
          }}
        />
      )}
      {newDmOpen && (
        <NewDmModal
          onClose={() => setNewDmOpen(false)}
          onOpened={(id) => {
            setNewDmOpen(false);
            setSidebarOpen(false);
            navigate(`/app/${id}`);
          }}
        />
      )}
      <Toast />
    </>
  );

  if (!isDesktop) {
    const sidebarProps = {
      collapsed: false,
      activeChannelId: channelId ?? "",
      onOpenSwitcher: () => navigate("/app/search"),
      onCreateChannel: () => setCreateOpen(true),
      onNewDm: () => setNewDmOpen(true),
      onOpenSettings: () => setSettingsOpen(true),
      onSignOut: () => void handleSignOut(),
    };
    const headerButton = "rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink";
    let screen;
    if (channelId) {
      screen = (
        <ChannelView
          channelId={channelId}
          onOpenSidebar={() => navigate("/app/home")}
          onBack={() => navigate(isDmChannel(channelId) ? "/app/dms" : "/app/home")}
          threadId={threadId}
          onOpenThread={openThread}
          onCloseThread={closeThread}
        />
      );
    } else if (newsMatch) {
      screen = (
        <Suspense fallback={<div className="flex-1" aria-busy="true" aria-label="Loading news" />}>
          <NewsView />
        </Suspense>
      );
    } else if (skillsMatch) {
      screen = (
        <Suspense
          fallback={<div className="flex-1" aria-busy="true" aria-label="Loading skills" />}
        >
          <SkillsView />
        </Suspense>
      );
    } else if (notesMatch) {
      screen = (
        <Suspense fallback={<div className="flex-1" aria-busy="true" aria-label="Loading notes" />}>
          <NotesHub />
        </Suspense>
      );
    } else if (calendarMatch) {
      screen = (
        <Suspense
          fallback={<div className="flex-1" aria-busy="true" aria-label="Loading calendar" />}
        >
          <CalendarView />
        </Suspense>
      );
    } else if (tasksMatch) {
      screen = (
        <Suspense fallback={<div className="flex-1" aria-busy="true" aria-label="Loading tasks" />}>
          <TaskManager boardId={tasksMatch.params.boardId} />
        </Suspense>
      );
    } else if (tab === "dms") {
      screen = (
        <MobileScreen
          title="Direct messages"
          actions={
            <button
              type="button"
              onClick={() => setNewDmOpen(true)}
              className={headerButton}
              aria-label="New direct message"
            >
              <PlusIcon />
            </button>
          }
        >
          <Sidebar only="dms" phone {...sidebarProps} />
        </MobileScreen>
      );
    } else if (tab === "activity") {
      screen = <ActivityScreen />;
    } else if (tab === "search") {
      screen = <SearchScreen />;
    } else {
      screen = (
        <div className="flex h-full min-h-0 flex-col bg-surface">
          <MobileHomeHeader
            onOpenWorkspace={() => setSheet("more")}
            onOpenHistory={() => setSheet("recents")}
            onOpenProfile={() => setSettingsOpen(true)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto pb-24">
            <ShortcutCards onOpenHuddles={() => setSheet("huddles")} />
            <Sidebar phone {...sidebarProps} />
          </div>
        </div>
      );
    }
    const closeSheet = () => setSheet(null);
    const go = (path: string) => {
      setSheet(null);
      void navigate(path);
    };
    return (
      // Phones: the screens are solid; the glass tab bar sits on the ambient background.
      <div className="flex h-full flex-col overflow-hidden">
        <main className="relative flex min-h-0 w-full flex-1 flex-col bg-surface">
          <PushPrompt phone />
          <ViewBoundary resetKey={pathname}>{screen}</ViewBoundary>
          {/* The "+" sits over the tab screens, never over a composer. */}
          {(tab === "home" || tab === "dms" || tab === "activity") && !keyboardUp && (
            <Fab onClick={() => setSheet("create")} />
          )}
        </main>
        <BottomTabs
          hidden={keyboardUp}
          moreOpen={sheet === "more"}
          onOpenMore={() => setSheet("more")}
        />
        {sheet === "more" && (
          <MoreSheet
            onClose={closeSheet}
            onOpenNotes={() => go("/app/notes")}
            onOpenNews={() => go("/app/news")}
            onOpenSkills={() => go("/app/skills")}
            onOpenSettings={() => {
              setSheet(null);
              setSettingsOpen(true);
            }}
            onSignOut={() => void handleSignOut()}
          />
        )}
        {sheet === "create" && (
          <CreateSheet
            onClose={closeSheet}
            onNewMessage={() => {
              setSheet(null);
              setNewDmOpen(true);
            }}
            onNewChannel={() => {
              setSheet(null);
              setCreateOpen(true);
            }}
            onNewTask={() => setSheet("task")}
          />
        )}
        {sheet === "task" && <NewTaskSheet onClose={closeSheet} />}
        {sheet === "recents" && <RecentsSheet onClose={closeSheet} />}
        {sheet === "huddles" && <HuddlesSheet onClose={closeSheet} />}
        {overlays}
      </div>
    );
  }

  return (
    <div
      // Transparent: the glass sidebar shows the ambient background (or, in the
      // desktop app, the blurred desktop) through it; the content pane is solid.
      className={`flex h-full overflow-hidden ${resizing ? "cursor-col-resize select-none" : ""}`}
    >
      {(sidebarOpen || drag !== null) && (
        <div
          className="fixed inset-0 z-30 bg-scrim/40 md:hidden"
          style={drag === null ? undefined : { opacity: drag }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        style={drawerStyle}
        className={`glass fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] border-r border-white/10 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:relative md:p-0 md:z-20 md:max-w-none md:shrink-0 md:translate-x-0 ${
          resizing ? "" : "transition-[transform,width] duration-200"
        } ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} ${
          // Nothing in the drawer is a hit target while it slides under the finger.
          drag === null ? "" : "pointer-events-none"
        }`}
      >
        <Sidebar
          activeChannelId={
            channelId ??
            (calendarMatch
              ? "calendar"
              : notesMatch
                ? "notes"
                : newsMatch
                  ? "news"
                  : skillsMatch
                    ? "skills"
                    : "tasks")
          }
          collapsed={collapsed}
          onToggleCollapsed={isDesktop ? toggleCollapsed : undefined}
          onOpenSwitcher={() => setSwitcherOpen(true)}
          onCreateChannel={() => setCreateOpen(true)}
          onNewDm={() => setNewDmOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSignOut={() => void handleSignOut()}
        />
        {isDesktop && !collapsed && (
          <button
            type="button"
            aria-label="Resize sidebar"
            title="Drag to resize · double-click to reset"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onDoubleClick={() => updateSidebar({ width: SIDEBAR_DEFAULT_WIDTH })}
            onKeyDown={onResizeKey}
            className={`absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors hover:after:bg-primary focus-visible:outline-none focus-visible:after:bg-primary ${
              resizing ? "after:bg-primary" : ""
            }`}
          />
        )}
      </aside>

      <main className="flex h-full w-full min-w-0 flex-1 flex-col bg-surface">
        <PushPrompt />
        <ViewBoundary resetKey={pathname}>
          {channelId ? (
            <ChannelView
              channelId={channelId}
              onOpenSidebar={() => setSidebarOpen(true)}
              threadId={threadId}
              onOpenThread={openThread}
              onCloseThread={closeThread}
            />
          ) : skillsMatch ? (
            <Suspense
              fallback={<div className="flex-1" aria-busy="true" aria-label="Loading skills" />}
            >
              <SkillsView onOpenSidebar={() => setSidebarOpen(true)} />
            </Suspense>
          ) : newsMatch ? (
            <Suspense
              fallback={<div className="flex-1" aria-busy="true" aria-label="Loading news" />}
            >
              <NewsView onOpenSidebar={() => setSidebarOpen(true)} />
            </Suspense>
          ) : notesMatch ? (
            <Suspense
              fallback={<div className="flex-1" aria-busy="true" aria-label="Loading notes" />}
            >
              <NotesHub onOpenSidebar={() => setSidebarOpen(true)} />
            </Suspense>
          ) : calendarMatch ? (
            <Suspense
              fallback={<div className="flex-1" aria-busy="true" aria-label="Loading calendar" />}
            >
              <CalendarView onOpenSidebar={() => setSidebarOpen(true)} />
            </Suspense>
          ) : (
            <Suspense
              fallback={<div className="flex-1" aria-busy="true" aria-label="Loading tasks" />}
            >
              <TaskManager
                boardId={tasksMatch?.params.boardId}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            </Suspense>
          )}
        </ViewBoundary>
      </main>

      {overlays}
    </div>
  );
}
