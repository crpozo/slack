import { isDesktopApp } from "./desktop";

// ---------------------------------------------------------------------------
// Links that leave the app (Phase 26). On the web they open in a new tab
// (`target="_blank" rel="noopener noreferrer"`, the browser's own way). In
// the desktop app a click would otherwise load the page inside the app's
// window and trap the person there, so every external link is sent to the
// OS's default browser through Tauri's opener plugin instead.
// ---------------------------------------------------------------------------

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Whether `href` leaves the app: another site, or a mail/phone link. */
export function isExternalUrl(href: string, appOrigin: string = location.origin): boolean {
  let url: URL;
  try {
    url = new URL(href, appOrigin);
  } catch {
    return false;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "mailto:" || url.protocol === "tel:") return true;
  return url.origin !== appOrigin;
}

interface TauriInvoke {
  core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
}

const tauri = (): TauriInvoke | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __TAURI__?: TauriInvoke }).__TAURI__;

export interface OpenExternalDeps {
  desktop?: boolean;
  invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  openWindow?: (url: string) => Window | null;
}

/**
 * The opener plugin isn't there or isn't allowed in this build (it predates
 * the permission): anything else means it ran, and may well have opened the
 * link already (some systems report an error after opening it).
 */
const OPENER_MISSING = /not allowed|not found|unknown command|no such|denied|no Tauri invoke/i;

/**
 * Opens `url` outside the app. Desktop: the opener plugin (the OS's default
 * browser or mail app); a build without it falls back to `window.open`,
 * which the desktop app routes to the browser. Web: a new tab, without access
 * back to this page.
 *
 * Never reports a failure: `window.open` answers `null` both when it opened
 * the link elsewhere (noopener on the web; the desktop app's routing) and when
 * it didn't, so a "couldn't open" message was wrong exactly when it worked.
 */
export async function openExternal(url: string, deps: OpenExternalDeps = {}): Promise<void> {
  const desktop = deps.desktop ?? isDesktopApp();
  const openWindow =
    deps.openWindow ??
    ((u: string) => window.open(u, "_blank", desktop ? undefined : "noopener,noreferrer"));
  if (!desktop) {
    openWindow(url);
    return;
  }
  const invoke = deps.invoke ?? tauri()?.core?.invoke;
  try {
    if (!invoke) throw new Error("no Tauri invoke");
    await invoke("plugin:opener|open_url", { url });
    return;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!OPENER_MISSING.test(why)) {
      // It ran: falling back too would open the link a second time.
      console.info("[external] opener reported an error after running", err);
      return;
    }
    console.info("[external] opener unavailable, falling back", err);
  }
  // The desktop app answers `window.open` by opening the URL in the browser (and no window here).
  openWindow(url);
}

/** The external link a click landed on, if any (left or middle button, no modifier needed). */
export function externalLinkOf(target: EventTarget | null, appOrigin?: string): string | null {
  const el = target instanceof Element ? target.closest("a[href]") : null;
  if (!el) return null;
  const href = el.getAttribute("href") ?? "";
  if (el.hasAttribute("download") || !isExternalUrl(href, appOrigin)) return null;
  return new URL(href, appOrigin ?? location.origin).href;
}

/**
 * Desktop app only: every click on an external link anywhere in the page
 * (messages, the lightbox, the PDF viewer, task files) opens it in the OS's
 * browser. Links whose own handler already took the click (`preventDefault`,
 * e.g. the router's) are left alone. Returns a function that removes it.
 */
export function installExternalLinks(): () => void {
  if (!isDesktopApp()) return () => {};
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
    const url = externalLinkOf(e.target);
    if (!url) return;
    e.preventDefault();
    void openExternal(url);
  };
  document.addEventListener("click", onClick);
  document.addEventListener("auxclick", onClick);
  return () => {
    document.removeEventListener("click", onClick);
    document.removeEventListener("auxclick", onClick);
  };
}
