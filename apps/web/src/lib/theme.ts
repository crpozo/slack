// ---------------------------------------------------------------------------
// The look (Phase 37b): one dark theme everywhere, Slack's palette with the brand green
// accents. No light theme, no setting. On top of it, "glass": translucent
// sidebar, headers and overlays over an ambient background (web), or over the
// desktop itself where the desktop app has real OS blur (see `nativeGlass`).
// ---------------------------------------------------------------------------

/** The browser chrome's colour (also in index.html and the web manifest). */
export const THEME_COLOR = "#1A1D21";

/** The old Light/Dark/System choice, no longer read. */
const LEGACY_THEME_KEY = "slack.theme";

/**
 * What the desktop app reports before the page loads: `"vibrancy"` (macOS) or
 * `"mica"` (Windows 11) when its window is transparent with the OS blurring
 * the desktop behind it; `null` (or absent: a browser, an older app,
 * Windows 10, Linux) otherwise.
 */
export type NativeGlass = "vibrancy" | "mica";

declare global {
  interface Window {
    __MINDFULTECH_GLASS__?: NativeGlass | null;
  }
}

export function nativeGlass(
  win: Pick<Window, "__MINDFULTECH_GLASS__"> = window,
): NativeGlass | null {
  const glass = win.__MINDFULTECH_GLASS__;
  return glass === "vibrancy" || glass === "mica" ? glass : null;
}

/**
 * Applies the look to <html>: always `dark`; `native-glass` only in the
 * desktop app's transparent window, where the page itself becomes
 * transparent so the OS-blurred desktop shows through. Anywhere else the page
 * paints its own ambient background (styles.css), so nothing can end up
 * see-through over an opaque window.
 */
export function applyTheme(): void {
  const root = document.documentElement;
  root.classList.add("dark");
  const glass = nativeGlass();
  root.classList.toggle("native-glass", glass !== null);
  if (glass) root.dataset.glass = glass;
  else delete root.dataset.glass;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR);
  try {
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Blocked storage: nothing to tidy.
  }
}
