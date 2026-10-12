export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 256;
/** Width of the icon-only rail. */
export const SIDEBAR_COLLAPSED_WIDTH = 64;

export interface SidebarPrefs {
  width: number;
  collapsed: boolean;
}

const STORAGE_KEY = "slack.sidebar";

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

export function loadSidebarPrefs(): SidebarPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { width, collapsed } = raw as Partial<SidebarPrefs>;
      return { width: clampSidebarWidth(Number(width)), collapsed: collapsed === true };
    }
  } catch {
    // fall through to defaults
  }
  return { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false };
}

export function saveSidebarPrefs(prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted; the layout still works for this session.
  }
}
