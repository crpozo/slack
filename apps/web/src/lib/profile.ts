import type { UserProfile } from "@mindfultech/shared";

/**
 * Your own profile, remembered on this device. Until the directory arrives
 * over the WebSocket the app only knows your email, so it used to show its
 * prefix ("carlos") instead of your display name — for seconds in a browser,
 * and for as long as the socket took in the desktop app, which starts with the
 * computer and may wait for the network. Seeding the store from this copy
 * shows the right name from the first frame; every `user.list` and
 * `user.updated` about you refreshes it.
 */
const key = (userId: string) => `slack.profile.${userId}`;

export function loadOwnProfile(userId: string): UserProfile | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(userId)) ?? "null") as UserProfile | null;
    return parsed?.userId === userId && typeof parsed.displayName === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveOwnProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(key(profile.userId), JSON.stringify(profile));
  } catch {
    // Storage blocked: the name still arrives with the directory.
  }
}

/**
 * The team's directory as the server last gave it, remembered per person on
 * this device. Until the directory arrives over the WebSocket the DM list had
 * to stand in with the build's VITE_USERS and old DM channels, so someone
 * whose account was deleted showed for a moment on every load. Seeding from
 * this copy lists exactly the people who were there last time; the next
 * `user.list` replaces it.
 */
const directoryKey = (userId: string) => `slack.directory.${userId}`;

export function loadDirectory(userId: string): UserProfile[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(directoryKey(userId)) ?? "null");
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (u): u is UserProfile => !!u && typeof u.userId === "string" && typeof u.email === "string",
    );
  } catch {
    return null;
  }
}

export function saveDirectory(userId: string, users: UserProfile[]): void {
  try {
    localStorage.setItem(directoryKey(userId), JSON.stringify(users));
  } catch {
    // Storage blocked or full: the list still arrives with the directory.
  }
}
