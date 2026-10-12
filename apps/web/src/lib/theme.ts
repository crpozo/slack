export type ThemePreference = "light" | "dark" | "system";

/** Same key as the inline script in index.html, which applies it before first paint. */
const STORAGE_KEY = "slack.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

const systemDark = () => window.matchMedia(DARK_QUERY).matches;

export function applyTheme(preference: ThemePreference = getThemePreference()): void {
  const dark = resolveTheme(preference, systemDark()) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0E0D12" : "#69C7B9");
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Blocked storage: the choice lasts for this page load only.
  }
  applyTheme(preference);
}

/** Follows OS theme changes while the preference is "system". Returns an unsubscribe. */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
