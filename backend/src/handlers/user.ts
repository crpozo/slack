import { paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseAction, UserActionSchema, type UserProfile } from "@mindfultech/shared";
import { broadcast, onlineUserIds } from "../lib/broadcast";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, reply } from "../lib/response";
import { toUserProfile } from "../lib/users";

/** Everyone who has signed in at least once (a handful of rows: a Scan is fine). */
async function scanUsers(): Promise<UserProfile[]> {
  const users: UserProfile[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.users })) {
    users.push(...(page.Items ?? []).map(toUserProfile));
  }
  return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** `user`: list the directory, or update your own display name. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(UserActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;

  if (action.op === "list") {
    const [users, online] = await Promise.all([scanUsers(), onlineUserIds()]);
    await reply(caller.connectionId, { type: "user.list", users, online });
    return ok();
  }

  // Only ever the caller's own row: the key comes from the authorizer, not the payload.
  const now = Date.now();
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId: caller.userId },
      UpdateExpression:
        "SET displayName = :name, email = :email, updatedAt = :now, " +
        "createdAt = if_not_exists(createdAt, :now)",
      ExpressionAttributeValues: {
        ":name": action.displayName,
        ":email": caller.userEmail,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  const user = toUserProfile(Attributes ?? { userId: caller.userId });
  log.info("display name updated", { userId: caller.userId });
  await broadcast(() => ({ type: "user.updated", user }));
  return ok();
});
