import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  paginateListUsers,
  paginateListUsersInGroup,
  UserNotFoundException,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ADMIN_GROUP,
  GUEST_GROUP,
  roleFromGroups,
  type AccountStatus,
  type Role,
  type TeamRole,
} from "@mindfultech/shared";
import { requireEnv } from "./env";

/**
 * Accounts for board invitations. Sign-up stays closed: only a board owner's
 * invite creates a (guest) account, and Cognito emails the temporary password
 * itself (its built-in sender: about 50 emails a day, plenty at this scale).
 */
let client: CognitoIdentityProviderClient | undefined;
const cognito = () => (client ??= new CognitoIdentityProviderClient({}));
const poolId = () => requireEnv("USER_POOL_ID");

export interface InvitedAccount {
  userId: string;
  email: string;
  role: Role;
  /** A new guest account was created (and emailed) by this invite. */
  created: boolean;
}

const subOf = (attributes: AttributeType[] | undefined): string | undefined =>
  attributes?.find((a) => a.Name === "sub")?.Value;

async function existing(email: string): Promise<InvitedAccount | null> {
  try {
    const user = await cognito().send(
      new AdminGetUserCommand({ UserPoolId: poolId(), Username: email }),
    );
    const userId = subOf(user.UserAttributes);
    if (!userId) throw new Error("Cognito user without a sub");
    const { Groups } = await cognito().send(
      new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: email }),
    );
    const role = roleFromGroups((Groups ?? []).map((g) => g.GroupName));
    // A guest who never set their password: send the invitation email again.
    if (role === "guest" && user.UserStatus === "FORCE_CHANGE_PASSWORD") {
      await cognito().send(
        new AdminCreateUserCommand({
          UserPoolId: poolId(),
          Username: email,
          MessageAction: "RESEND",
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
    }
    return { userId, email, role, created: false };
  } catch (err) {
    if (err instanceof UserNotFoundException) return null;
    throw err;
  }
}

/**
 * The account for `email`: an existing one (member, admin or guest) as is, or
 * a new guest account. New guests are put in the `guests` group *before* they
 * can ever sign in (they don't know the password until the email arrives), so
 * no token without the group is ever issued for them.
 */
export async function findOrInviteGuest(email: string): Promise<InvitedAccount> {
  const found = await existing(email);
  if (found) return found;
  const { User } = await cognito().send(
    new AdminCreateUserCommand({
      UserPoolId: poolId(),
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }),
  );
  const userId = subOf(User?.Attributes);
  if (!userId) throw new Error("Cognito returned no sub for the new user");
  try {
    await cognito().send(
      new AdminAddUserToGroupCommand({
        UserPoolId: poolId(),
        Username: email,
        GroupName: GUEST_GROUP,
      }),
    );
  } catch (err) {
    // Without the group the account would sign in as a full member: never keep it.
    await cognito()
      .send(new AdminDeleteUserCommand({ UserPoolId: poolId(), Username: email }))
      .catch(() => undefined);
    throw err;
  }
  return { userId, email, role: "guest", created: true };
}

/**
 * Whether a Cognito account with this `sub` still exists. Cognito is the
 * source of truth: a `users` row can outlive its account (an admin deleted
 * it from the console). `ListUsers` with a `sub` filter works whatever the
 * pool's username scheme is.
 */
export async function accountExists(sub: string): Promise<boolean> {
  // The filter is a quoted string: never let a caller-supplied quote break out of it.
  if (!/^[\w-]+$/.test(sub)) return false;
  const { Users } = await cognito().send(
    new ListUsersCommand({
      UserPoolId: poolId(),
      Filter: `sub = "${sub}"`,
      Limit: 1,
      AttributesToGet: ["sub"],
    }),
  );
  return (Users?.length ?? 0) > 0;
}

/** The `sub` of every account in the pool (paginated `ListUsers`). */
export async function allAccountSubs(): Promise<Set<string>> {
  const subs = new Set<string>();
  const pages = paginateListUsers(
    { client: cognito() },
    { UserPoolId: poolId(), AttributesToGet: ["sub"] },
  );
  for await (const page of pages) {
    for (const user of page.Users ?? []) {
      const id = subOf(user.Attributes);
      if (id) subs.add(id);
    }
  }
  return subs;
}

/**
 * Ids (`sub`) of every account in the admins group: who decides vacation
 * requests, so they can be told about new ones. Best effort: a Cognito error
 * means an empty list, never a failed request.
 */
export async function adminUserIds(): Promise<string[]> {
  const ids: string[] = [];
  let next: string | undefined;
  try {
    do {
      const page = await cognito().send(
        new ListUsersInGroupCommand({
          UserPoolId: poolId(),
          GroupName: ADMIN_GROUP,
          NextToken: next,
        }),
      );
      for (const user of page.Users ?? []) {
        const id = subOf(user.Attributes);
        if (id) ids.push(id);
      }
      next = page.NextToken;
    } while (next);
  } catch {
    return ids;
  }
  return ids;
}

// --- Phase 62: the team panel (admins invite staff and admins, change roles) ---------

/** An account as the team panel lists it (names come from `users`). */
export interface PoolAccount {
  userId: string;
  username: string;
  email: string;
  role: Role;
  status: AccountStatus;
  createdAt: number;
}

/** The usernames in a group (paginated). */
async function groupMembers(group: string): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const page of paginateListUsersInGroup(
    { client: cognito() },
    { UserPoolId: poolId(), GroupName: group },
  )) {
    for (const user of page.Users ?? []) if (user.Username) names.add(user.Username);
  }
  return names;
}

const statusOf = (enabled: boolean | undefined, status: string | undefined): AccountStatus =>
  enabled === false ? "disabled" : status === "FORCE_CHANGE_PASSWORD" ? "invited" : "active";

/** Every account in the pool, with its role (from its groups) and status. */
export async function listPoolAccounts(): Promise<PoolAccount[]> {
  const [admins, guests] = await Promise.all([
    groupMembers(ADMIN_GROUP),
    groupMembers(GUEST_GROUP),
  ]);
  const accounts: PoolAccount[] = [];
  for await (const page of paginateListUsers({ client: cognito() }, { UserPoolId: poolId() })) {
    for (const user of page.Users ?? []) {
      const userId = subOf(user.Attributes);
      if (!userId || !user.Username) continue;
      const groups = [
        ...(guests.has(user.Username) ? [GUEST_GROUP] : []),
        ...(admins.has(user.Username) ? [ADMIN_GROUP] : []),
      ];
      accounts.push({
        userId,
        username: user.Username,
        email: user.Attributes?.find((a) => a.Name === "email")?.Value ?? "",
        role: roleFromGroups(groups),
        status: statusOf(user.Enabled, user.UserStatus),
        createdAt: user.UserCreateDate?.getTime() ?? 0,
      });
    }
  }
  return accounts;
}

/** The email already has an account (of any role). */
export class AccountExistsError extends Error {
  constructor(email: string) {
    super(`${email} already has an account`);
    this.name = "AccountExistsError";
  }
}

/**
 * Creates a staff or admin account for `email`: Cognito emails the temporary
 * password (and the sign-in link) itself. An admin is put in the `admins`
 * group before they can ever sign in; if that fails the account is deleted,
 * so nobody is left with a role they weren't given.
 */
export async function createTeamAccount(
  email: string,
  role: TeamRole,
): Promise<{ userId: string; username: string; createdAt: number }> {
  if (await existing(email)) throw new AccountExistsError(email);
  const { User } = await cognito().send(
    new AdminCreateUserCommand({
      UserPoolId: poolId(),
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }),
  );
  const userId = subOf(User?.Attributes);
  if (!userId || !User?.Username) throw new Error("Cognito returned no sub for the new user");
  if (role === "admin") {
    try {
      await cognito().send(
        new AdminAddUserToGroupCommand({
          UserPoolId: poolId(),
          Username: User.Username,
          GroupName: ADMIN_GROUP,
        }),
      );
    } catch (err) {
      await cognito()
        .send(new AdminDeleteUserCommand({ UserPoolId: poolId(), Username: User.Username }))
        .catch(() => undefined);
      throw err;
    }
  }
  return {
    userId,
    username: User.Username,
    createdAt: User.UserCreateDate?.getTime() ?? Date.now(),
  };
}

/** The pool account with this `sub`, or `null`. */
export async function accountBySub(sub: string): Promise<PoolAccount | null> {
  if (!/^[\w-]+$/.test(sub)) return null;
  const { Users } = await cognito().send(
    new ListUsersCommand({ UserPoolId: poolId(), Filter: `sub = "${sub}"`, Limit: 1 }),
  );
  const user = Users?.[0];
  if (!user?.Username) return null;
  const { Groups } = await cognito().send(
    new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: user.Username }),
  );
  return {
    userId: sub,
    username: user.Username,
    email: user.Attributes?.find((a) => a.Name === "email")?.Value ?? "",
    role: roleFromGroups((Groups ?? []).map((g) => g.GroupName)),
    status: statusOf(user.Enabled, user.UserStatus),
    createdAt: user.UserCreateDate?.getTime() ?? 0,
  };
}

/** Moves a staff account into the `admins` group, or an admin out of it. */
export async function setAdmin(username: string, admin: boolean): Promise<void> {
  const input = { UserPoolId: poolId(), Username: username, GroupName: ADMIN_GROUP };
  await cognito().send(
    admin ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input),
  );
}
