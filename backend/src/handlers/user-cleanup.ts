import { requireEnv } from "../lib/env";
import { errorFields, log } from "../lib/logger";
import {
  cleanUpDeletedAccount,
  reconcileOrphans,
  type AdminDeleteUserDetail,
} from "../lib/orphans";

/** The EventBridge envelope of an "AWS API Call via CloudTrail" event. */
interface CloudTrailEvent {
  "detail-type"?: string;
  source?: string;
  detail?: AdminDeleteUserDetail;
}

/** The schedule's own input (see infra `UserSync`): reconcile the whole table. */
export const RECONCILE = { action: "reconcile" } as const;
type ReconcileEvent = typeof RECONCILE;

/**
 * Keeps `users` a mirror of Cognito. Two EventBridge triggers:
 * - Cognito's AdminDeleteUser (via CloudTrail): removes that account's
 *   profile at once. Only while a CloudTrail trail logs in the account.
 * - Every 15 minutes (`RECONCILE`): removes every profile whose account is
 *   gone, however it went (console, CLI, no trail). The safety net.
 * Either way the profile leaves everyone's DM list and directory. Errors are
 * rethrown so EventBridge retries the event.
 */
export async function handler(
  event: CloudTrailEvent | ReconcileEvent,
): Promise<{ deleted: string[] }> {
  try {
    if ("action" in event && event.action === RECONCILE.action) {
      const deleted = await reconcileOrphans();
      if (deleted.length > 0) log.info("user cleanup reconciled", { deleted });
      return { deleted };
    }
    event = event as CloudTrailEvent;
    const result = await cleanUpDeletedAccount(event.detail ?? {}, requireEnv("USER_POOL_ID"));
    log.info("user cleanup", { ...result });
    return { deleted: result.deleted };
  } catch (err) {
    log.error("user cleanup failed", errorFields(err));
    throw err;
  }
}
