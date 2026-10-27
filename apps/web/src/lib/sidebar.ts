export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
/**
 * Wide enough for the header to show the logo, "MindfulTech" and its two
 * buttons without truncating the name (at 256 it read "MindfulT…").
 */
export const SIDEBAR_DEFAULT_WIDTH = 288;
/** The default before 288: a saved width of exactly this is the old default, not a choice. */
const LEGACY_DEFAULT_WIDTH = 256;
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
      const chosen = Number(width) === LEGACY_DEFAULT_WIDTH ? SIDEBAR_DEFAULT_WIDTH : Number(width);
      return { width: clampSidebarWidth(chosen), collapsed: collapsed === true };
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

// --- Phones (Phase 37): Home's accordion sections -----------------------------------

export type PhoneSection = "pinned" | "channels" | "dms" | "apps";
/** Which of Home's sections are folded away (all open by default), on this device. */
export type PhoneSections = Record<PhoneSection, boolean>;

const PHONE_SECTIONS_KEY = "slack.phone.collapsed";
const ALL_OPEN: PhoneSections = { pinned: false, channels: false, dms: false, apps: false };

export function loadPhoneSections(): PhoneSections {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PHONE_SECTIONS_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const r = raw as Partial<PhoneSections>;
      return {
        pinned: r.pinned === true,
        channels: r.channels === true,
        dms: r.dms === true,
        apps: r.apps === true,
      };
    }
  } catch {
    // fall through to defaults
  }
  return { ...ALL_OPEN };
}

export function savePhoneSections(collapsed: PhoneSections): void {
  try {
    localStorage.setItem(PHONE_SECTIONS_KEY, JSON.stringify(collapsed));
  } catch {
    // Not persisted; the sections still fold for this session.
  }
}
