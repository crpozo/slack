import { DeleteCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import { isExternalId } from "@mindfultech/shared";
import { accountExists, allAccountSubs } from "./cognito";
import { ddb, tables } from "./ddb";
import { log } from "./logger";

/**
 * Orphaned `users` rows: profiles whose Cognito account was deleted (an
 * admin's AdminDeleteUser). They kept showing in the DM list, and opening a
 * DM with one hung the app. `user-cleanup` removes them as accounts go.
 */

/** A Cognito `sub` (a UUID). Anything else is never used as a `users` key. */
const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSub = (value: unknown): value is string =>
  typeof value === "string" && SUB.test(value);

/** The bits of an "AWS API Call via CloudTrail" event for AdminDeleteUser we read. */
export interface AdminDeleteUserDetail {
  eventName?: string;
  errorCode?: string;
  requestParameters?: { userPoolId?: string; username?: string } | null;
  additionalEventData?: { sub?: string } | null;
}

/**
 * The `sub` of the account an AdminDeleteUser call deleted, or `null` when
 * the event doesn't say. CloudTrail hides `username` from Cognito events
 * (HIDDEN_DUE_TO_SECURITY_REASONS) but puts the `sub` in
 * `additionalEventData`. In this pool (email sign-in) the username *is* the
 * sub, so an unhidden username is used as a fallback.
 */
export function deletedSub(detail: AdminDeleteUserDetail): string | null {
  if (isSub(detail.additionalEventData?.sub)) return detail.additionalEventData.sub;
  if (isSub(detail.requestParameters?.username)) return detail.requestParameters.username;
  return null;
}

/** Removes one profile row (a no-op when it's already gone). */
export async function deleteUserRow(userId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: tables.users, Key: { userId } }));
}

/** Every `users` row's id that should map to a Cognito account (externals never do). */
async function profileIds(): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of paginateScan(
    { client: ddb },
    { TableName: tables.users, ProjectionExpression: "userId" },
  )) {
    for (const item of page.Items ?? []) {
      const id = String(item.userId);
      if (!isExternalId(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * Deletes every `users` row with no Cognito account, and returns their ids.
 * Run every 15 minutes (the safety net that needs no CloudTrail) and for an
 * event that names no `sub`. Refuses to act on an empty pool listing, or
 * when not one profile has an account (both mean a wrong pool id, which
 * would otherwise wipe the directory).
 */
export async function reconcileOrphans(): Promise<string[]> {
  const [ids, subs] = await Promise.all([profileIds(), allAccountSubs()]);
  if (subs.size === 0) throw new Error("Cognito listed no accounts: refusing to delete profiles");
  const orphans = ids.filter((id) => !subs.has(id));
  if (ids.length > 1 && orphans.length === ids.length) {
    throw new Error(
      `None of the ${ids.length} profiles has an account in this pool: refusing to delete them`,
    );
  }
  await Promise.all(orphans.map((id) => deleteUserRow(id)));
  return orphans;
}

/**
 * Handles one AdminDeleteUser event: deletes that account's profile, after
 * checking the account really is gone (a failed call, or another pool's
 * event that slipped past the rule, deletes nothing). Without a `sub` in the
 * event, reconciles the whole table instead (a handful of rows).
 */
export async function cleanUpDeletedAccount(
  detail: AdminDeleteUserDetail,
  poolId: string,
): Promise<{ deleted: string[]; reason: string }> {
  if (detail.eventName !== "AdminDeleteUser" || detail.errorCode) {
    return { deleted: [], reason: "not a successful AdminDeleteUser" };
  }
  if (detail.requestParameters?.userPoolId !== poolId) {
    return { deleted: [], reason: "another user pool" };
  }
  const sub = deletedSub(detail);
  if (!sub) {
    log.warn("AdminDeleteUser event without a sub: reconciling the whole table");
    return { deleted: await reconcileOrphans(), reason: "reconciled" };
  }
  if (await accountExists(sub)) return { deleted: [], reason: "account still exists" };
  await deleteUserRow(sub);
  return { deleted: [sub], reason: "deleted" };
}
