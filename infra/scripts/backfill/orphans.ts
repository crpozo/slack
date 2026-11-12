import {
  paginateListUsers,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, paginateScan, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isExternalId } from "@mindfultech/shared";

export interface Orphan {
  userId: string;
  email: string;
  displayName: string;
}

export interface OrphanReport {
  /** `users` rows checked (externals' rows never map to an account and are skipped). */
  profiles: number;
  /** Accounts in the user pool. */
  accounts: number;
  orphans: Orphan[];
  deleted: number;
}

/** The `sub` of every account in the pool. */
async function accountSubs(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
): Promise<Set<string>> {
  const subs = new Set<string>();
  for await (const page of paginateListUsers(
    { client: cognito },
    { UserPoolId: userPoolId, AttributesToGet: ["sub"] },
  )) {
    for (const user of page.Users ?? []) {
      const sub = user.Attributes?.find((a) => a.Name === "sub")?.Value;
      if (sub) subs.add(sub);
    }
  }
  return subs;
}

/**
 * Finds `users` rows whose Cognito account no longer exists and, with
 * `apply`, deletes them. Refuses to delete when the pool lists no accounts
 * (a wrong pool id), or when more than half the directory would go unless
 * `force`: an orphan cleanup that big is far more likely a mistake.
 */
export async function cleanupOrphans(
  ddb: DynamoDBDocumentClient,
  cognito: CognitoIdentityProviderClient,
  {
    table,
    userPoolId,
    apply,
    force = false,
  }: {
    table: string;
    userPoolId: string;
    apply: boolean;
    force?: boolean;
  },
): Promise<OrphanReport> {
  const profiles: Orphan[] = [];
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: table,
      ProjectionExpression: "userId, email, displayName",
    },
  )) {
    for (const item of page.Items ?? []) {
      const userId = String(item.userId);
      if (isExternalId(userId)) continue;
      profiles.push({
        userId,
        email: typeof item.email === "string" ? item.email : "",
        displayName: typeof item.displayName === "string" ? item.displayName : "",
      });
    }
  }
  const subs = await accountSubs(cognito, userPoolId);
  const orphans = profiles.filter((p) => !subs.has(p.userId));
  const report: OrphanReport = {
    profiles: profiles.length,
    accounts: subs.size,
    orphans,
    deleted: 0,
  };
  if (!apply || orphans.length === 0) return report;

  if (subs.size === 0) {
    throw new Error(`User pool ${userPoolId} lists no accounts: refusing to delete any profile`);
  }
  if (!force && orphans.length > profiles.length / 2) {
    throw new Error(
      `${orphans.length} of ${profiles.length} profiles have no account: ` +
        "that looks like the wrong pool. Re-run with --force if it really is right.",
    );
  }
  for (const orphan of orphans) {
    await ddb.send(new DeleteCommand({ TableName: table, Key: { userId: orphan.userId } }));
    report.deleted++;
  }
  return report;
}
