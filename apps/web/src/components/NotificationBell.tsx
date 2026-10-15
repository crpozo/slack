import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDay, formatTime } from "../lib/channels";
import { useNotifications, useUnreadAlerts, type AppAlert } from "../store/notifications";
import { BellIcon, HandWaveIcon, KanbanIcon, MessageIcon } from "./icons";
import { Popover } from "./Popover";

const KIND_ICON: Record<AppAlert["kind"], typeof BellIcon> = {
  message: MessageIcon,
  mention: MessageIcon,
  nudge: HandWaveIcon,
  task: KanbanIcon,
};

/** Red dot for "you have unread alerts", e.g. on the phone's menu button. */
export function UnreadAlertsDot() {
  const unread = useUnreadAlerts();
  if (unread === 0) return null;
  return (
    <span
      className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-surface bg-error"
      aria-label={`${unread} unread notifications`}
    />
  );
}

/**
 * Bell with a red unread count; opens the recent alerts (DMs, @mentions,
 * pings, board activity). Opening it marks them read; a click jumps there.
 */
export function NotificationBell({ className }: Readonly<{ className: string }>) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const alerts = useNotifications((s) => s.alerts);
  const unread = useUnreadAlerts();
  const navigate = useNavigate();

  const close = () => {
    setAnchor(null);
    useNotifications.getState().markAllRead();
  };
  const open = (alert: AppAlert) => {
    close();
    void navigate(alert.url);
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget))}
        className={`relative ${className}`}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-error px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close}>
          <div
            role="dialog"
            aria-label="Notifications"
            className="flex max-h-[min(28rem,70vh)] w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-line bg-surface-raised shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <h2 className="text-sm font-semibold text-ink">Notifications</h2>
              {alerts.length > 0 && (
                <button
                  type="button"
                  onClick={() => useNotifications.getState().clear()}
                  className="rounded px-1.5 py-0.5 text-xs text-ink-secondary hover:bg-surface-hover hover:text-ink"
                >
                  Clear all
                </button>
              )}
            </div>
            {alerts.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-secondary">
                Nothing new. DMs, @mentions, pings and board activity show up here.
              </p>
            ) : (
              <ul className="overflow-y-auto py-1">
                {alerts.map((alert) => {
                  const Icon = KIND_ICON[alert.kind];
                  return (
                    <li key={alert.id}>
                      <button
                        type="button"
                        onClick={() => open(alert)}
                        className="flex w-full gap-2.5 px-3 py-2 text-left hover:bg-surface-hover"
                      >
                        <span className="mt-0.5 text-ink-secondary">
                          <Icon />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span
                              className={`truncate text-sm text-ink ${alert.read ? "" : "font-semibold"}`}
                            >
                              {alert.title}
                            </span>
                            <span className="ml-auto shrink-0 text-[11px] text-ink-secondary">
                              {formatDay(alert.at) === "Today"
                                ? formatTime(alert.at)
                                : formatDay(alert.at)}
                            </span>
                          </span>
                          <span className="line-clamp-2 text-xs text-ink-secondary">
                            {alert.body}
                          </span>
                        </span>
                        {!alert.read && (
                          <span
                            className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-error"
                            aria-label="Unread"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
