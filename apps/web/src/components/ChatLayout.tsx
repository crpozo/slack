import { GENERAL_CHANNEL_ID, isDmChannel } from "@mindfultech/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { signOut } from "../lib/auth";
import { chat } from "../lib/chat";
import { dmPeer } from "../lib/channels";
import {
  clampSidebarWidth,
  loadSidebarPrefs,
  saveSidebarPrefs,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type SidebarPrefs,
} from "../lib/sidebar";
import { selectUnread, useChat } from "../store";
import { CreateChannelModal } from "./ChannelModals";
import { ChannelView } from "./ChannelView";
import { QuickSwitcher } from "./QuickSwitcher";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";

const BASE_TITLE = "MindfulTech Slack";
const DESKTOP_QUERY = "(min-width: 768px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function ChatLayout({ wsUrl }: { wsUrl: string }) {
  const { channelId = GENERAL_CHANNEL_ID } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

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

  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, width: sidebar.width };
    setResizing(true);
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
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
  function onResizeKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") updateSidebar({ width: clampSidebarWidth(sidebar.width - step) });
    else if (e.key === "ArrowRight")
      updateSidebar({ width: clampSidebarWidth(sidebar.width + step) });
    else return;
    e.preventDefault();
  }

  const handleSignOut = useCallback(async () => {
    chat.stop();
    await signOut().catch(() => {});
    useChat.getState().setSession(null);
  }, []);

  // One WebSocket for the whole signed-in session. (Declared first: effects run in order.)
  useEffect(() => {
    chat.start(wsUrl, () => {
      useChat.getState().showToast("Tu sesión expiró. Vuelve a iniciar sesión.");
      void handleSignOut();
    });
    return () => chat.stop();
  }, [wsUrl, handleSignOut]);

  // Switching channels: load its history once and mark it read.
  useEffect(() => {
    const s = useChat.getState();
    s.setActiveChannel(channelId);
    setSidebarOpen(false);
    if (!(channelId in s.cursors)) chat.loadHistory(channelId, "initial");
    s.markRead(channelId);
  }, [channelId]);

  // A DM link for a conversation that doesn't exist yet: create it.
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const channelExists = useChat((s) => s.channels.some((c) => c.channelId === channelId));
  const myUserId = useChat((s) => s.me?.userId);
  useEffect(() => {
    if (!channelsLoaded || channelExists || !myUserId || !isDmChannel(channelId)) return;
    const peer = dmPeer(channelId, myUserId);
    if (peer) chat.openDm(peer);
  }, [channelId, channelsLoaded, channelExists, myUserId]);

  // Back to the window: what's on screen counts as read.
  useEffect(() => {
    const onFocus = () => useChat.getState().markRead(channelId);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [channelId]);

  // Ctrl/Cmd + K quick switcher, Ctrl/Cmd + B collapse the sidebar.
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

  return (
    <div
      className={`flex h-full overflow-hidden bg-surface ${resizing ? "cursor-col-resize select-none" : ""}`}
    >
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-scrim/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        style={isDesktop ? { width: sidebarWidth } : undefined}
        className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] md:relative md:z-20 md:max-w-none md:shrink-0 md:translate-x-0 ${
          resizing ? "" : "transition-[transform,width] duration-200"
        } ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <Sidebar
          activeChannelId={channelId}
          collapsed={collapsed}
          onToggleCollapsed={isDesktop ? toggleCollapsed : undefined}
          onOpenSwitcher={() => setSwitcherOpen(true)}
          onCreateChannel={() => setCreateOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSignOut={() => void handleSignOut()}
        />
        {isDesktop && !collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Cambiar el ancho de la barra lateral"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebar.width}
            tabIndex={0}
            title="Arrastra para cambiar el ancho · doble clic para restablecer"
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

      <main className="flex min-w-0 flex-1 flex-col">
        <ChannelView channelId={channelId} onOpenSidebar={() => setSidebarOpen(true)} />
      </main>

      {switcherOpen && <QuickSwitcher onClose={() => setSwitcherOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {createOpen && (
        <CreateChannelModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate(`/app/${id}`);
          }}
        />
      )}
      <Toast />
    </div>
  );
}
