import { createHash } from "node:crypto";
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  isAllowedPushEndpoint,
  type PushPayload,
  type PushSubscriptionJSON,
} from "@mindfultech/shared";
import webpush, { WebPushError } from "web-push";
import { ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";
import { vapidConfig } from "./vapid";

/**
 * Rows of `push-subscriptions`: one per browser/device a user enabled push on.
 *   `{ userId, sk: sha256(endpoint), subscription, userAgent, createdAt }`
 */
export interface PushSubscriptionItem {
  userId: string;
  sk: string;
  subscription: PushSubscriptionJSON;
  userAgent?: string;
  createdAt: number;
}

/** Messages older than this aren't worth a notification. */
const PUSH_TTL_SECONDS = 60 * 60;

export const endpointKey = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("base64url");

export async function saveSubscription(
  userId: string,
  subscription: PushSubscriptionJSON,
  userAgent: string | undefined,
): Promise<void> {
  const item: PushSubscriptionItem = {
    userId,
    sk: endpointKey(subscription.endpoint),
    subscription,
    ...(userAgent && { userAgent: userAgent.slice(0, 256) }),
    createdAt: Date.now(),
  };
  await ddb.send(new PutCommand({ TableName: tables.pushSubscriptions, Item: item }));
}

export async function deleteSubscription(userId: string, endpoint: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: tables.pushSubscriptions,
      Key: { userId, sk: endpointKey(endpoint) },
    }),
  );
}

async function subscriptionsOf(userId: string): Promise<PushSubscriptionItem[]> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: tables.pushSubscriptions,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
    }),
  );
  return (Items ?? []) as PushSubscriptionItem[];
}

/**
 * Sends `payload` to every device of `userIds`. Never throws: the message was
 * already delivered over WebSocket, a notification is a bonus. Subscriptions
 * the push service reports gone (404/410) are deleted.
 * @returns how many notifications the push services accepted.
 */
export async function sendPush(userIds: string[], payload: PushPayload): Promise<number> {
  if (userIds.length === 0) return 0;
  try {
    const vapid = await vapidConfig();
    if (!vapid) return 0;
    const rows = (await Promise.all(userIds.map(subscriptionsOf))).flat();
    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(
      rows.map(async (row) => {
        // Re-checked on send too: rows written before validation existed, or by hand.
        if (!isAllowedPushEndpoint(row.subscription.endpoint)) {
          throw new Error("disallowed push endpoint");
        }
        try {
          await webpush.sendNotification(row.subscription, body, {
            vapidDetails: vapid,
            TTL: PUSH_TTL_SECONDS,
            urgency: "high",
            topic: payload.tag.replace(/[^\w-]/g, "").slice(0, 32) || undefined,
            timeout: 5000,
          });
        } catch (err) {
          if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
            await deleteSubscription(row.userId, row.subscription.endpoint);
            log.info("removed expired push subscription", { userId: row.userId });
          }
          throw err;
        }
      }),
    );
    const sent = results.filter((r) => r.status === "fulfilled").length;
    if (sent < rows.length) {
      log.warn("some pushes failed", { attempted: rows.length, sent });
    }
    return sent;
  } catch (err) {
    log.error("push failed", errorFields(err));
    return 0;
  }
}
