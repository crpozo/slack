import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isRole, type Role } from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import { ddb, tables, type ConnectionItem } from "../lib/ddb";
import type { WsEvent } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { ok, type HandlerResult } from "../lib/response";
import { defaultDisplayName } from "../lib/users";

const CONNECTION_TTL_SECONDS = 2 * 60 * 60;

/**
 * Keeps the `users` directory current: creates the row on first login and
 * refreshes the email, never overwriting a display name the user chose.
 */
async function upsertUser(userId: string, email: string, role: Role, now: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.users,
      Key: { userId },
      // The role follows the Cognito groups on every sign-in (moving someone in or
      // out of `guests` takes effect at their next connection).
      UpdateExpression:
        "SET email = :email, #role = :role, displayName = if_not_exists(displayName, :name), " +
        "createdAt = if_not_exists(createdAt, :now), updatedAt = if_not_exists(updatedAt, :now)",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: {
        ":email": email,
        ":role": role,
        ":name": defaultDisplayName(email),
        ":now": now,
      },
    }),
  );
}

/**
 * Presence: tells everyone else this user is online. The new connection itself
 * is skipped — it can't receive messages until `$connect` returns (it gets the
 * snapshot from `user.list` instead). Best effort: never blocks the connection.
 */
async function announce(connectionId: string, userId: string): Promise<void> {
  try {
    const others = (await listConnections()).filter((c) => c.connectionId !== connectionId);
    await deliver(others, () => ({ type: "user.connected", userId }));
  } catch (err) {
    log.warn("presence broadcast failed", { userId, ...errorFields(err) });
  }
}

/** `$connect`: the authorizer already validated the token; store the connection. */
export const handler = async (event: WsEvent): Promise<HandlerResult> => {
  const { connectionId, authorizer } = event.requestContext;
  if (!authorizer?.userId || !authorizer.email) {
    log.warn("connect without authorizer context", { connectionId });
    return { statusCode: 401 };
  }

  const now = Date.now();
  const role = isRole(authorizer.role) ? authorizer.role : "member";
  const item: ConnectionItem = {
    connectionId,
    userId: authorizer.userId,
    userEmail: authorizer.email,
    connectedAt: now,
    ttl: Math.floor(now / 1000) + CONNECTION_TTL_SECONDS,
    role,
  };

  const [connection, user] = await Promise.allSettled([
    ddb.send(new PutCommand({ TableName: tables.connections, Item: item })),
    upsertUser(item.userId, item.userEmail, role, now),
  ]);
  if (connection.status === "rejected") {
    log.error("connect failed", { connectionId, ...errorFields(connection.reason) });
    return { statusCode: 500 };
  }
  // The directory is best effort: a failed upsert must not block the connection.
  if (user.status === "rejected") {
    log.warn("user upsert failed", { userId: item.userId, ...errorFields(user.reason) });
  }
  await announce(connectionId, item.userId);
  log.info("connected", { connectionId, userId: item.userId });
  return ok();
};
