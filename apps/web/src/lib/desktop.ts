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
 * stays open while the window is in the background, so the app raises native
 * notifications itself (DMs, @mentions and board activity).
 *
 * Two things the browser APIs get wrong inside the desktop app, and why this
 * module asks Tauri instead:
 *   - focus: in Windows' WebView2, `document.hasFocus()` and
 *     `visibilityState` don't change when the window loses focus or is
 *     minimized, so the app always looked "in front" and never notified.
 *     Tauri's own window state is the truth.
 *   - delivery: the plugin's `sendNotification()` fires and forgets (errors
 *     vanish); calling its `notify` command directly lets failures be logged.
 * Everything here only uses permissions the 0.1.0 app already grants
 * (`core:default`, `notification:default`), so no reinstall is needed.
 */
interface TauriWindow {
  isFocused(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<() => void>;
}

interface TauriGlobal {
  core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  window?: { getCurrentWindow(): TauriWindow };
  notification?: {
    isPermissionGranted(): Promise<boolean>;
    requestPermission(): Promise<NotificationPermission>;
  };
}

const tauri = (): TauriGlobal | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;

const trace = (step: string, detail?: unknown) => console.info("[desktop]", step, detail ?? "");

/** Whether this page runs inside the desktop app. */
export const isDesktopApp = (): boolean => tauri() !== undefined;

function currentWindow(): TauriWindow | null {
  try {
    return tauri()?.window?.getCurrentWindow() ?? null;
  } catch {
    return null;
  }
}

/** The desktop window is focused and not minimized; `null` outside the desktop app. */
export async function desktopWindowFocused(): Promise<boolean | null> {
  const win = currentWindow();
  if (!win) return null;
  try {
    const [focused, minimized] = await Promise.all([win.isFocused(), win.isMinimized()]);
    return focused && !minimized;
  } catch (err) {
    trace("focus check failed", err);
    return null;
  }
}

/**
 * Calls `onChange` with the desktop window's focus whenever it changes (and
 * once with the current state). A no-op outside the desktop app.
 */
export function watchDesktopFocus(onChange: (focused: boolean) => void): () => void {
  const win = currentWindow();
  if (!win) return () => {};
  let stop: (() => void) | null = null;
  let stopped = false;
  void desktopWindowFocused().then((focused) => focused !== null && !stopped && onChange(focused));
  win
    .onFocusChanged(({ payload }) => onChange(payload))
    .then((unlisten) => (stopped ? unlisten() : (stop = unlisten)))
    .catch((err: unknown) => trace("can't watch focus", err));
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Whether `message` would have been pushed to `me` (mirrors the backend's `pushRecipients`). */
export function shouldNotify(
  channel: Pick<Channel, "type"> | undefined,
  message: Pick<Message, "userId" | "text">,
  me: { userId: string; email: string; displayName?: string },
): boolean {
  if (!channel || message.userId === me.userId) return false;
  // DMs and private channels (small groups): every message. Public: @mentions only.
  if (channel.type === "dm" || channel.type === "private") return true;
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

/** Asks the OS once per run (macOS prompts; Windows always allows); later calls reuse the answer. */
function granted(): Promise<boolean> {
  const api = tauri()?.notification;
  if (!api) return Promise.resolve(true); // the notify command decides
  permission ??= api
    .isPermissionGranted()
    .then(async (ok) => ok || (await api.requestPermission()) === "granted")
    .then((ok) => {
      trace("notification permission", ok ? "granted" : "denied");
      return ok;
    })
    .catch((err: unknown) => {
      trace("permission check failed", err);
      permission = null; // ask again next time
      return true;
    });
  return permission;
}

/**
 * Native notification from the desktop app, only while its window is in the
 * background (re-checked with Tauri right before showing). A no-op in
 * browsers. Never throws; every outcome is logged as `[desktop]`.
 * @returns whether a notification was shown.
 */
export async function notifyDesktop(title: string, body: string): Promise<boolean> {
  const core = tauri()?.core;
  if (!core) return false;
  try {
    if ((await desktopWindowFocused()) === true) {
      trace("skipped: window is focused");
      return false;
    }
    if (!(await granted())) {
      trace("skipped: notifications are off for the app");
      return false;
    }
    await core.invoke("plugin:notification|notify", { options: { title, body } });
    trace("notification shown", { title });
    return true;
  } catch (err) {
    console.warn("[desktop] notification failed", err);
    return false;
  }
}

/** Ask for permission early (at sign-in) so the first DM doesn't wait on a prompt. */
export function prepareDesktopNotifications(): void {
  if (isDesktopApp()) void granted();
}
