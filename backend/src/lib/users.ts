import { MAX_DISPLAY_NAME_LENGTH, type UserProfile } from "@mindfultech/shared";

/** Default display name: the local part of the email. */
export function defaultDisplayName(email: string): string {
  return (email.split("@")[0] || email).slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/** Row of the `users` table, as sent to clients. */
export function toUserProfile(item: Record<string, unknown>): UserProfile {
  const email = typeof item.email === "string" ? item.email : "";
  return {
    userId: String(item.userId),
    email,
    displayName:
      typeof item.displayName === "string" ? item.displayName : defaultDisplayName(email),
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
  };
}
