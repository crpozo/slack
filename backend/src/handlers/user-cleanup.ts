import { requireEnv } from "../lib/env";
import { errorFields, log } from "../lib/logger";
import { cleanUpDeletedAccount, type AdminDeleteUserDetail } from "../lib/orphans";

/** The EventBridge envelope of an "AWS API Call via CloudTrail" event. */
interface CloudTrailEvent {
  "detail-type"?: string;
  source?: string;
  detail?: AdminDeleteUserDetail;
}

/**
 * EventBridge target for Cognito's AdminDeleteUser (via CloudTrail): removes
 * the deleted account's profile from `users`, so it leaves everyone's DM list
 * and directory. Errors are rethrown so EventBridge retries the event.
 */
export async function handler(event: CloudTrailEvent): Promise<{ deleted: string[] }> {
  try {
    const result = await cleanUpDeletedAccount(event.detail ?? {}, requireEnv("USER_POOL_ID"));
    log.info("user cleanup", { ...result });
    return { deleted: result.deleted };
  } catch (err) {
    log.error("user cleanup failed", errorFields(err));
    throw err;
  }
}
