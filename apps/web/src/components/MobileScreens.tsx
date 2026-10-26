import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { formatDay, formatTime } from "../lib/channels";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";
import { selectUnread, useChat, useNameOf } from "../store";
import { useNotifications, useUnreadAlerts, type AppAlert } from "../store/notifications";
import { Avatar } from "./Avatar";
import { ChannelIcon } from "./ChannelIcon";
import {
  BellIcon,
  CalendarIcon,
  ChevronRightIcon,
  HashIcon,
  KanbanIcon,
  LogOutIcon,
  MessageIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
} from "./icons";
import { Modal } from "./Modal";
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
  { path: "more", label: "More", icon: MoreHorizontalIcon },
] as const;

/**
 * The bar paints edge-to-edge (its background runs under the home indicator)
 * and pads its buttons above it, so nothing bare shows beneath. The active
 * tab's icon sits in a pill, like Slack's.
 */
export function BottomTabs({
  onOpenSettings,
  onSignOut,
}: Readonly<{ onOpenSettings: () => void; onSignOut: () => void }>) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
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
    <>
      <nav
        className="flex shrink-0 border-t border-line bg-surface px-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1"
        aria-label="Main"
      >
        {TABS.map((tab) => {
          const isMore = tab.path === "more";
          const active = isMore ? moreOpen : tab.path === activePath && !moreOpen;
          const count = isMore ? 0 : badge(tab.path);
          return (
            <button
              key={tab.path}
              type="button"
              onClick={() => (isMore ? setMoreOpen(true) : navigate(tab.path))}
              aria-current={active ? "page" : undefined}
              aria-haspopup={isMore ? "dialog" : undefined}
              className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-1 text-[11px] font-medium transition-colors ${
                active ? "text-primary" : "text-ink-secondary"
              }`}
            >
              <span
                className={`relative flex h-8 w-16 items-center justify-center rounded-full text-xl transition-colors ${
                  active ? "bg-primary/20" : ""
                }`}
              >
                <tab.icon />
                {count > 0 && (
                  <span
                    className="absolute right-2 top-0 min-w-[1.1rem] rounded-full bg-error px-1 text-center text-[10px] font-bold leading-[1.1rem] text-white ring-2 ring-surface"
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
      {moreOpen && (
        <MoreSheet
          onClose={() => setMoreOpen(false)}
          onOpenNotes={() => {
            setMoreOpen(false);
            void navigate("/app/notes");
          }}
          onOpenNews={() => {
            setMoreOpen(false);
            void navigate("/app/news");
          }}
          onOpenSettings={() => {
            setMoreOpen(false);
            onOpenSettings();
          }}
          onSignOut={onSignOut}
        />
      )}
    </>
  );
}

const THEMES: Array<{ value: ThemePreference; label: string; Icon: typeof SunIcon }> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

/** The More tab's sheet: who you are, the theme, AI Notes, AI News, settings and sign out. */
function MoreSheet({
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
  const nameOf = useNameOf();
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  if (!me) return null;
  const row =
    "flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-ink active:bg-surface-hover";
  return (
    <Modal title="More" width="sm" onClose={onClose}>
      <div className="-mx-5 -my-4 divide-y divide-line pb-[env(safe-area-inset-bottom)]">
        <button type="button" onClick={onOpenSettings} className={row}>
          <Avatar name={nameOf(me.userId, me.email)} mine size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{nameOf(me.userId, me.email)}</span>
            <span className="block truncate text-xs text-ink-secondary">{me.email}</span>
          </span>
          <span className="text-xs text-ink-secondary">Edit profile</span>
          <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
        </button>
        <div className="px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            Theme
          </p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => {
                  setTheme(value);
                  setThemePreference(value);
                }}
                className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-xs font-medium ${
                  theme === value
                    ? "border-primary bg-primary/15 text-ink"
                    : "border-line text-ink-secondary"
                }`}
              >
                <Icon className="text-lg" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={onOpenNotes} className={row}>
          <SparklesIcon className="text-primary" />
          <span className="flex-1">AI Notes</span>
          <span className="text-xs text-ink-secondary">Summaries of your calls</span>
          <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
        </button>
        <button type="button" onClick={onOpenNews} className={row}>
          <span className="w-[1em] text-center" aria-hidden="true">
            📰
          </span>
          <span className="flex-1">AI News</span>
          <span className="text-xs text-ink-secondary">The latest from TechCrunch</span>
          <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
        </button>
        <button type="button" onClick={onOpenSettings} className={row}>
          <SettingsIcon className="text-ink-secondary" />
          <span className="flex-1">Settings</span>
          <span className="text-xs text-ink-secondary">Notifications, audio &amp; video</span>
          <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
        </button>
        <button type="button" onClick={onSignOut} className={`${row} text-error`}>
          <LogOutIcon />
          Sign out
        </button>
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
                <ChannelIcon channel={{ type: item.channelType ?? "public" }} />
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
