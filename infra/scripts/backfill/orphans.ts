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
  const profiles = await scanProfiles(ddb, table);
  const subs = await accountSubs(cognito, userPoolId);
  const orphans = profiles.filter((p) => !subs.has(p.userId));
  const report: OrphanReport = {
    profiles: profiles.length,
    accounts: subs.size,
    orphans,
    deleted: 0,
  };
  if (!apply || orphans.length === 0) return report;

  assertSafeToDelete(report, userPoolId, force);
  await Promise.all(
    orphans.map((orphan) =>
      ddb.send(new DeleteCommand({ TableName: table, Key: { userId: orphan.userId } })),
    ),
  );
  report.deleted = orphans.length;
  return report;
}

/** One `users` row as the report shows it. */
const toOrphan = (item: Record<string, unknown>): Orphan => ({
  userId: String(item.userId),
  email: typeof item.email === "string" ? item.email : "",
  displayName: typeof item.displayName === "string" ? item.displayName : "",
});

/** Every `users` row that should map to an account (externals' rows never do). */
async function scanProfiles(ddb: DynamoDBDocumentClient, table: string): Promise<Orphan[]> {
  const profiles: Orphan[] = [];
  const pages = paginateScan(
    { client: ddb },
    { TableName: table, ProjectionExpression: "userId, email, displayName" },
  );
  for await (const page of pages) {
    profiles.push(...(page.Items ?? []).map(toOrphan).filter((p) => !isExternalId(p.userId)));
  }
  return profiles;
}

/** Throws when deleting these orphans looks like a mistake (see `cleanupOrphans`). */
function assertSafeToDelete(report: OrphanReport, userPoolId: string, force: boolean): void {
  if (report.accounts === 0) {
    throw new Error(`User pool ${userPoolId} lists no accounts: refusing to delete any profile`);
  }
  if (!force && report.orphans.length > report.profiles / 2) {
    throw new Error(
      `${report.orphans.length} of ${report.profiles} profiles have no account: ` +
        "that looks like the wrong pool. Re-run with --force if it really is right.",
    );
  }
}
