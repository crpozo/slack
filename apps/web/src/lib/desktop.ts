import {
  findMentions,
  mentionHandle,
  PUSH_PREVIEW_LENGTH,
  type Channel,
  type Message,
} from "@mindfultech/shared";

/**
 * The Tauri desktop app (`apps/desktop`) loads this same site in a native
 * window and injects `window.__TAURI__` (`withGlobalTauri`). Its WebSocket
 * stays open while the window is hidden, so the server never sends Web Push
 * to it: the app raises native notifications itself, for what a push would
 * have carried (DMs and @mentions).
 */
interface TauriNotificationApi {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<NotificationPermission>;
  sendNotification(options: { title: string; body?: string }): void;
}

interface TauriGlobal {
  notification?: TauriNotificationApi;
}

const tauri = (): TauriGlobal | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;

/** Whether this page runs inside the desktop app. */
export const isDesktopApp = (): boolean => tauri() !== undefined;

/** Whether `message` would have been pushed to `me` (mirrors the backend's `pushRecipients`). */
export function shouldNotify(
  channel: Pick<Channel, "type"> | undefined,
  message: Pick<Message, "userId" | "text">,
  me: { userId: string; email: string; displayName?: string },
): boolean {
  if (!channel || message.userId === me.userId) return false;
  if (channel.type === "dm") return true;
  const handles = new Set(findMentions(message.text));
  const local = (me.email.split("@")[0] ?? "").toLowerCase();
  return (
    (!!me.displayName && handles.has(mentionHandle(me.displayName))) ||
    (!!local && handles.has(local))
  );
}

/** One line of the message, like the push preview. */
export function notificationBody(message: Pick<Message, "text" | "attachments">): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text) {
    if (message.attachments.some((a) => a.contentType.startsWith("audio/")))
      return "🎤 Voice message";
    return message.attachments.length > 0 ? "📎 Sent a file" : "New message";
  }
  return text.length > PUSH_PREVIEW_LENGTH
    ? `${text.slice(0, PUSH_PREVIEW_LENGTH - 1).trimEnd()}…`
    : text;
}

let permission: Promise<boolean> | null = null;

/** Asks the OS once per run; later calls reuse the answer. */
function granted(api: TauriNotificationApi): Promise<boolean> {
  permission ??= api
    .isPermissionGranted()
    .then(async (ok) => ok || (await api.requestPermission()) === "granted")
    .catch(() => false);
  return permission;
}

/** Native notification from the desktop app; a no-op in browsers. Never throws. */
export async function notifyDesktop(title: string, body: string): Promise<void> {
  const api = tauri()?.notification;
  if (!api) return;
  try {
    if (await granted(api)) api.sendNotification({ title, body });
  } catch (err) {
    console.warn("[desktop] notification failed", err);
  }
}

/** Ask for permission early (at sign-in) so the first DM doesn't wait on a prompt. */
export function prepareDesktopNotifications(): void {
  const api = tauri()?.notification;
  if (api) void granted(api);
}
