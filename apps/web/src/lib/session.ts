import type { SessionUser } from "./auth";

/**
 * The last signed-in user, so the shell paints before Amplify has verified
 * the session (it does, in the background; a dead session signs out). No
 * tokens here, only what the UI needs to draw: ids, the email, the role.
 */
const KEY = "slack.session";

export function loadSessionSnapshot(): SessionUser | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as SessionUser).userId === "string" &&
      typeof (parsed as SessionUser).email === "string"
    ) {
      return parsed as SessionUser;
    }
  } catch {
    // Unreadable: start cold.
  }
  return null;
}

export function saveSessionSnapshot(user: SessionUser | null): void {
  try {
    if (user) localStorage.setItem(KEY, JSON.stringify(user));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the next start is a cold one.
  }
}
