// ---------------------------------------------------------------------------
// The app on the Home Screen (Phase 56): MindfulTech is a web app that
// installs from the browser (no App Store). On iPhone and iPad that's Safari's
// Share → Add to Home Screen, which is also what push notifications need.
// ---------------------------------------------------------------------------

export type InstallPlatform = "ios" | "android" | "desktop";

/** iPhone, iPod or iPad (iPadOS says it's a Mac: it has a touch screen). */
export const isIos = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Opened from the Home Screen (or installed on a computer), not in a browser tab. */
export const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Which steps to show first. */
export function installPlatform(): InstallPlatform {
  if (isIos()) return "ios";
  if (/Android/i.test(navigator.userAgent)) return "android";
  return "desktop";
}

const BANNER_KEY = "install.banner.dismissed";

/** Whether to suggest installing: an iPhone or iPad in the browser, not hidden before. */
export function shouldSuggestInstall(): boolean {
  if (typeof window === "undefined" || !isIos() || isStandalone()) return false;
  try {
    return localStorage.getItem(BANNER_KEY) !== "1";
  } catch {
    return true;
  }
}

/** "No thanks": never suggested again on this device. */
export function dismissInstallSuggestion(): void {
  try {
    localStorage.setItem(BANNER_KEY, "1");
  } catch {
    // Not remembered: it shows again next time.
  }
}
