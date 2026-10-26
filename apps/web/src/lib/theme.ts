export type ThemePreference = "light" | "dark" | "system";

/** Same key as the inline script in index.html, which applies it before first paint. */
const STORAGE_KEY = "slack.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
/** Same as `MOBILE_QUERY` (lib/hooks.ts), repeated in index.html's inline script. */
const PHONE_QUERY = "(max-width: 767px)";

/** The browser chrome's colour for each look. */
export const THEME_COLORS = { light: "#69C7B9", dark: "#0E0D12", phone: "#1A1D21" } as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Light (white) unless the user picked Dark or System in Settings. */
export const DEFAULT_THEME: ThemePreference = "light";

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/**
 * Phase 37: phones always get Slack's dark look (`phone` + `dark` on <html>),
 * whatever the preference; it applies again on desktop widths.
 */
export function resolveLook(
  preference: ThemePreference,
  systemDark: boolean,
  phone: boolean,
): keyof typeof THEME_COLORS {
  return phone ? "phone" : resolveTheme(preference, systemDark);
}

const systemDark = () => window.matchMedia(DARK_QUERY).matches;
/** A narrow window, except the desktop app's small call window (`/call/pip`), which isn't a phone. */
export const isPhone = () =>
  !window.location.pathname.startsWith("/call/") && window.matchMedia(PHONE_QUERY).matches;

export function applyTheme(preference: ThemePreference = getThemePreference()): void {
  const look = resolveLook(preference, systemDark(), isPhone());
  const root = document.documentElement.classList;
  root.toggle("phone", look === "phone");
  root.toggle("dark", look !== "light");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[look]);
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Blocked storage: the choice lasts for this page load only.
  }
  applyTheme(preference);
}

/**
 * Follows OS theme changes while the preference is "system", and the width
 * crossing the phone breakpoint (a rotation, a resized window). Returns an
 * unsubscribe.
 */
export function watchSystemTheme(): () => void {
  const dark = window.matchMedia(DARK_QUERY);
  const phone = window.matchMedia(PHONE_QUERY);
  const onDark = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  const onPhone = () => applyTheme();
  dark.addEventListener("change", onDark);
  phone.addEventListener("change", onPhone);
  return () => {
    dark.removeEventListener("change", onDark);
    phone.removeEventListener("change", onPhone);
  };
}
