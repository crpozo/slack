import { BatchGetCommand, type BatchGetCommandOutput } from "@aws-sdk/lib-dynamodb";
import { isRole, MAX_DISPLAY_NAME_LENGTH, type UserProfile } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

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
    ...(isRole(item.role) && item.role !== "member" && { role: item.role }),
  };
}

/** User ids among `keys` that exist in `users`; retries `UnprocessedKeys` (throttling) once. */
export async function existingUserIds(
  keys: Record<string, unknown>[],
  retries = 1,
): Promise<string[]> {
  const result: BatchGetCommandOutput = await ddb.send(
    new BatchGetCommand({
      RequestItems: { [tables.users]: { Keys: keys, ProjectionExpression: "userId" } },
    }),
  );
  const found = (result.Responses?.[tables.users] ?? []).map((item) => String(item.userId));
  const unprocessed = result.UnprocessedKeys?.[tables.users]?.Keys;
  if (!unprocessed?.length || retries <= 0) return found;
  return [...found, ...(await existingUserIds(unprocessed, retries - 1))];
}

/** Ids among `userIds` that have no row in `users` (never signed in). */
export async function unknownUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const found = new Set(await existingUserIds(userIds.map((userId) => ({ userId }))));
  return userIds.filter((id) => !found.has(id));
}

/** Which of `userIds` are guests (per their `users` row); they never join chats. */
export async function guestsAmong(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const result = await ddb.send(
    new BatchGetCommand({
      RequestItems: {
        [tables.users]: {
          Keys: [...new Set(userIds)].map((userId) => ({ userId })),
          ProjectionExpression: "userId, #role",
          ExpressionAttributeNames: { "#role": "role" },
        },
      },
    }),
  );
  return (result.Responses?.[tables.users] ?? [])
    .filter((item) => item.role === "guest")
    .map((item) => String(item.userId));
}
