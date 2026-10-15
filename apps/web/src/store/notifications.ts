import { create } from "zustand";

/**
 * In-app alerts behind the bell: DMs and @mentions, pings, and board activity
 * (new tasks, tasks moved to another column), newest first. Kept per user in
 * localStorage so a reload doesn't empty the list; what happened while the app
 * was closed arrives as Web Push instead.
 */
export type AlertKind = "message" | "mention" | "nudge" | "task";

export interface AppAlert {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  /** App path to open, e.g. `/app/<channelId>` or `/app/tasks/<boardId>`. */
  url: string;
  /** Epoch milliseconds. */
  at: number;
  read: boolean;
}

export const MAX_ALERTS = 50;

interface NotificationsState {
  userId: string | null;
  alerts: AppAlert[];
  /** Loads `userId`'s saved alerts (on sign-in); `null` clears them (sign-out). */
  load: (userId: string | null) => void;
  /** `read`: already seen (e.g. it happened on the screen you're looking at). */
  add: (alert: Omit<AppAlert, "id" | "at" | "read">, read?: boolean) => void;
  markAllRead: () => void;
  clear: () => void;
}

const storageKey = (userId: string) => `slack.alerts.${userId}`;

function readSaved(userId: string): AppAlert[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]");
    return Array.isArray(parsed) ? (parsed as AppAlert[]).slice(0, MAX_ALERTS) : [];
  } catch {
    return [];
  }
}

function save(userId: string | null, alerts: AppAlert[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(alerts));
  } catch {
    // Storage full or blocked: the list still works for this session.
  }
}

let counter = 0;

export const useNotifications = create<NotificationsState>((set, get) => {
  const update = (alerts: AppAlert[]) => {
    set({ alerts });
    save(get().userId, alerts);
  };
  return {
    userId: null,
    alerts: [],
    load: (userId) => set({ userId, alerts: userId ? readSaved(userId) : [] }),
    add: (alert, read = false) => {
      const at = Date.now();
      const entry: AppAlert = { ...alert, id: `${at}-${counter++}`, at, read };
      update([entry, ...get().alerts].slice(0, MAX_ALERTS));
    },
    markAllRead: () => {
      if (get().alerts.some((a) => !a.read))
        update(get().alerts.map((a) => ({ ...a, read: true })));
    },
    clear: () => update([]),
  };
});

export const useUnreadAlerts = () =>
  useNotifications((s) => s.alerts.filter((a) => !a.read).length);
