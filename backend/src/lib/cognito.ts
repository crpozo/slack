import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import { GUEST_GROUP, roleFromGroups, type Role } from "@mindfultech/shared";
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
