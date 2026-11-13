import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { paginateScan, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  InviteTeamMemberSchema,
  SetTeamRoleSchema,
  type TeamList,
  type TeamMember,
} from "@mindfultech/shared";
import {
  accountBySub,
  AccountExistsError,
  createTeamAccount,
  listPoolAccounts,
  setAdmin,
  type PoolAccount,
} from "../lib/cognito";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { log } from "../lib/logger";
import { defaultDisplayName } from "../lib/users";

/** The team panel is for admins only (the role comes from the token's Cognito groups). */
function adminOnly(caller: HttpCaller): void {
  if (caller.role !== "admin") throw forbidden("Only an admin can manage the team");
}

/** Display names from `users` (people who never signed in may have none yet). */
async function displayNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for await (const page of paginateScan(
    { client: ddb },
    { TableName: tables.users, ProjectionExpression: "userId, displayName" },
  )) {
    for (const item of page.Items ?? []) {
      if (typeof item.displayName === "string" && item.displayName) {
        names.set(String(item.userId), item.displayName);
      }
    }
  }
  return names;
}

const toMember = (account: PoolAccount, name?: string): TeamMember => ({
  userId: account.userId,
  email: account.email,
  displayName: name || defaultDisplayName(account.email),
  role: account.role,
  status: account.status,
  createdAt: account.createdAt,
});

/** `GET /admin/users`: every account, staff and admins first, then guests. */
async function listTeam(caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller);
  const [accounts, names] = await Promise.all([listPoolAccounts(), displayNames()]);
  const order = { admin: 0, member: 0, guest: 1 } as const;
  const members = accounts
    .map((a) => toMember(a, names.get(a.userId)))
    .sort((a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName));
  return json(200, { members } satisfies TeamList);
}

/**
 * `POST /admin/users`: invites someone to the team. Cognito creates the
 * account and emails the temporary password; their profile goes in `users`
 * with the role at once, so they're in the directory before they sign in.
 */
async function invite(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller);
  const input = parseBody(InviteTeamMemberSchema, event);
  let account: Awaited<ReturnType<typeof createTeamAccount>>;
  try {
    account = await createTeamAccount(input.email, input.role);
  } catch (err) {
    if (err instanceof AccountExistsError) throw new HttpError(409, err.message);
    throw err;
  }
  const now = Date.now();
  const displayName = input.displayName || defaultDisplayName(input.email);
  await ddb.send(
    new PutCommand({
      TableName: tables.users,
      Item: {
        userId: account.userId,
        email: input.email,
        displayName,
        role: input.role,
        updatedAt: now,
        invitedBy: caller.userId,
        invitedAt: now,
      },
      ConditionExpression: "attribute_not_exists(userId)",
    }),
  );
  log.info("team member invited", { userId: account.userId, role: input.role, by: caller.userId });
  const member: TeamMember = {
    userId: account.userId,
    email: input.email,
    displayName,
    role: input.role,
    status: "invited",
    createdAt: account.createdAt,
  };
  return json(201, { member });
}

/**
 * `PUT /admin/users/{userId}/role`: staff ↔ admin. Never your own role (so
 * the team can't lose its last admin by accident), never a guest's (guests
 * come from channel invites). Takes effect at the person's next token
 * refresh (within the hour) or sign-in.
 */
async function changeRole(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  adminOnly(caller);
  const userId = decodeURIComponent(pathParam(event, "userId"));
  const { role } = parseBody(SetTeamRoleSchema, event);
  if (userId === caller.userId) throw new HttpError(409, "You can't change your own role");
  const account = await accountBySub(userId);
  if (!account) throw notFound("No such account");
  if (account.role === "guest") throw new HttpError(409, "Guests' access is managed per channel");
  if (account.role !== role) await setAdmin(account.username, role === "admin");
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId },
        UpdateExpression: "SET #role = :role, updatedAt = :now",
        ConditionExpression: "attribute_exists(userId)",
        ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: { ":role": role, ":now": Date.now() },
      }),
    );
  } catch (err) {
    // No profile yet (never signed in, not invited from here): Cognito holds the role.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  log.info("team role changed", { userId, role, by: caller.userId });
  return json(200, { member: toMember({ ...account, role }) });
}

/**
 * The team panel (Phase 62), on the HTTP API behind the Cognito JWT authorizer:
 *   GET  /admin/users                  → `{ members }`
 *   POST /admin/users                  → 201 `{ member }` (invites by email)
 *   PUT  /admin/users/{userId}/role    → `{ member }`
 */
export const handler = httpHandler(async (event, caller) => {
  switch (event.routeKey) {
    case "GET /admin/users":
      return listTeam(caller);
    case "POST /admin/users":
      return invite(event, caller);
    case "PUT /admin/users/{userId}/role":
      return changeRole(event, caller);
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});
