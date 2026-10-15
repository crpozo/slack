import { watchDesktopFocus } from "./desktop";

/**
 * Whether the app is in front of the person: the page is visible and focused.
 * Drives "you're looking at this conversation" (read receipts, no sound) and
 * the `active` flag of the heartbeat, which decides whether the server pushes
 * to their phone.
 *
 * In the desktop app the window's focus comes from Tauri (`desktopFocused`):
 * Windows' WebView2 keeps `document.hasFocus()` true when the window is in the
 * background or minimized.
 */
let desktopFocused: boolean | null = null;

export function isAppActive(): boolean {
  if (typeof document === "undefined") return false;
  if (desktopFocused !== null) return desktopFocused;
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Calls `onChange(active)` when `isAppActive()` flips: window focus/blur,
 * tab visibility, and the desktop window's focus.
 */
export function watchActivity(onChange: (active: boolean) => void): () => void {
  let last = isAppActive();
  const check = () => {
    const now = isAppActive();
    if (now === last) return;
    last = now;
    onChange(now);
  };
  // After blur/focus the DOM state settles a tick later.
  const later = () => setTimeout(check, 0);
  window.addEventListener("focus", later);
  window.addEventListener("blur", later);
  document.addEventListener("visibilitychange", later);
  const stopDesktop = watchDesktopFocus((focused) => {
    desktopFocused = focused;
    check();
  });
  return () => {
    window.removeEventListener("focus", later);
    window.removeEventListener("blur", later);
    document.removeEventListener("visibilitychange", later);
    stopDesktop();
  };
}

/** Tests only. */
export function resetActivity(): void {
  desktopFocused = null;
}
