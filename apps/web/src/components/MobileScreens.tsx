import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { formatDay, formatTime } from "../lib/channels";
import { selectUnread, useChat } from "../store";
import { useNotifications, useUnreadAlerts, type AppAlert } from "../store/notifications";
import { BellIcon, CalendarIcon, HashIcon, KanbanIcon, MessageIcon, SearchIcon } from "./icons";
import { useSwitcherItems } from "./QuickSwitcher";

// ---------------------------------------------------------------------------
// Phones (Phase 23): a fixed tab bar instead of the drawer. Home (channels),
// DMs, Activity and Search are full-screen tabs; a conversation opens on top
// with a back arrow and hides the bar (the keyboard needs the room).
// ---------------------------------------------------------------------------

export const MOBILE_HOME = "/app/home";

const TABS = [
  { path: "/app/home", label: "Home", icon: HashIcon },
  { path: "/app/dms", label: "DMs", icon: MessageIcon },
  { path: "/app/activity", label: "Activity", icon: BellIcon },
  { path: "/app/search", label: "Search", icon: SearchIcon },
] as const;

export function BottomTabs() {
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
  // Apps (tasks, calendar) are reached from Home: that tab stays lit there.
  const activePath = TABS.some((t) => t.path === pathname) ? pathname : "/app/home";
  return (
    <nav
      className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      aria-label="Main"
    >
      {TABS.map((tab) => {
        const active = tab.path === activePath;
        const count = badge(tab.path);
        return (
          <button
            key={tab.path}
            type="button"
            onClick={() => navigate(tab.path)}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-1 flex-col items-center gap-0.5 px-2 pb-1.5 pt-2 text-[11px] font-medium ${
              active ? "text-primary" : "text-ink-secondary"
            }`}
          >
            <span className="relative text-xl">
              <tab.icon />
              {count > 0 && (
                <span
                  className="absolute -right-2 -top-1 min-w-[1.1rem] rounded-full bg-error px-1 text-center text-[10px] font-bold leading-[1.1rem] text-white"
                  aria-label={`${count} unread`}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </span>
            {tab.label}
          </button>
        );
      })}
    </nav>
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 pt-[env(safe-area-inset-top)]">
        <h1 className="min-w-0 flex-1 truncate text-xl font-bold text-ink">{title}</h1>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** Quick links to the apps, at the top of Home. */
export function AppsRow() {
  const navigate = useNavigate();
  const link =
    "flex flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-surface-sidebar px-3 py-2.5 text-sm font-medium text-ink";
  return (
    <div className="flex gap-2 px-3 pt-3">
      <button type="button" className={link} onClick={() => navigate("/app/tasks")}>
        <KanbanIcon className="text-ink-secondary" /> Tasks
      </button>
      <button type="button" className={link} onClick={() => navigate("/app/calendar")}>
        <CalendarIcon className="text-ink-secondary" /> Calendar
      </button>
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
        <p className="px-6 py-12 text-center text-sm text-ink-secondary">
          Nothing new. DMs, @mentions, board and calendar activity show up here.
        </p>
      ) : (
        <ul className="divide-y divide-line/60">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <button
                type="button"
                onClick={() => open(alert)}
                className="flex w-full gap-3 px-4 py-3 text-left active:bg-surface-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span
                      className={`truncate text-sm text-ink ${alert.read ? "" : "font-semibold"}`}
                    >
                      {alert.title}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-ink-secondary">
                      {formatDay(alert.at) === "Today" ? formatTime(alert.at) : formatDay(alert.at)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-xs text-ink-secondary">{alert.body}</span>
                </span>
                {!alert.read && (
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-error"
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
      <div className="sticky top-0 border-b border-line bg-surface px-3 py-2">
        <label className="flex items-center gap-2 rounded-xl bg-surface-sidebar px-3">
          <SearchIcon className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels or people…"
            aria-label="Search"
            autoFocus
            className="w-full bg-transparent py-2.5 text-base text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
      </div>
      <ul role="listbox" className="py-1">
        {items.map((item) => (
          <li key={item.key} role="option" aria-selected={false}>
            <button
              type="button"
              onClick={item.go}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-ink active:bg-surface-hover"
            >
              {item.kind === "channel" ? (
                <HashIcon className="text-ink-secondary" />
              ) : (
                <span className="w-[1em] text-center text-ink-secondary">@</span>
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="truncate text-xs text-ink-secondary">{item.hint}</span>
              )}
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-ink-secondary">No results</li>
        )}
      </ul>
    </MobileScreen>
  );
}
