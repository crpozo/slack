import { GENERAL_CHANNEL_ID, isDmChannel } from "@mindfultech/shared";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { signOut } from "../lib/auth";
import { chat } from "../lib/chat";
import { dmPeer } from "../lib/channels";
import { selectUnread, useChat } from "../store";
import { ChannelView } from "./ChannelView";
import { QuickSwitcher } from "./QuickSwitcher";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";

const BASE_TITLE = "MindfulTech Slack";

export function ChatLayout({ wsUrl }: { wsUrl: string }) {
  const { channelId = GENERAL_CHANNEL_ID } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

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

  // Ctrl/Cmd + K quick switcher.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    <div className="flex h-full overflow-hidden bg-surface">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transition-transform duration-200 md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 lg:w-72 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          activeChannelId={channelId}
          onOpenSwitcher={() => setSwitcherOpen(true)}
          onSignOut={() => void handleSignOut()}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <ChannelView channelId={channelId} onOpenSidebar={() => setSidebarOpen(true)} />
      </main>

      {switcherOpen && <QuickSwitcher onClose={() => setSwitcherOpen(false)} />}
      <Toast />
    </div>
  );
}
