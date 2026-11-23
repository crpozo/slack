import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// The look: dark (the default, Phase 37b) or light (Phase 76), chosen by the
// person and kept in their browser. On top of it, "glass": translucent
// sidebar, headers and overlays over an ambient background (web), or, in the
// dark look, over the desktop itself where the desktop app has real OS blur
// (see `nativeGlass`). The palettes are in styles.css.
// ---------------------------------------------------------------------------

export type Appearance = "dark" | "light";

/** The browser chrome's colour (also in index.html and the web manifest). */
export const THEME_COLOR = "#1A1D21";
export const LIGHT_THEME_COLOR = "#FFFFFF";

/** Where the choice is kept (also read by index.html before the first paint). */
export const APPEARANCE_KEY = "slack.appearance";
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

/** The person's choice; dark unless they picked light. */
export function getAppearance(): Appearance {
  try {
    return localStorage.getItem(APPEARANCE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const listeners = new Set<() => void>();

/** Keeps the choice and applies it at once, everywhere it's shown. */
export function setAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch {
    // Blocked storage: the choice lasts for this visit.
  }
  applyTheme(appearance);
  for (const listener of listeners) listener();
}

let current: Appearance | null = null;

/** The look in use, for a component that shows or changes it. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current ?? getAppearance(),
  );
}

/**
 * Applies the look to <html>: `dark` or `light`; `native-glass` only in the
 * desktop app's transparent window and only in the dark look, where the page
 * itself becomes transparent so the OS-blurred desktop shows through (the
 * light look paints its own background: dark blur behind dark text wouldn't
 * read). Anywhere else the page paints its ambient background (styles.css).
 */
export function applyTheme(appearance: Appearance = getAppearance()): void {
  current = appearance;
  const root = document.documentElement;
  root.classList.toggle("dark", appearance === "dark");
  root.classList.toggle("light", appearance === "light");
  const glass = appearance === "dark" ? nativeGlass() : null;
  root.classList.toggle("native-glass", glass !== null);
  if (glass) root.dataset.glass = glass;
  else delete root.dataset.glass;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", appearance === "light" ? LIGHT_THEME_COLOR : THEME_COLOR);
  try {
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Blocked storage: nothing to tidy.
  }
}
