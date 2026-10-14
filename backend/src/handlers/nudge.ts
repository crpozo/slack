import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  dmChannelId,
  NUDGE_INTERVAL_MS,
  NudgeActionSchema,
  parseAction,
} from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { sendPush } from "../lib/push";
import { badRequest, ok, replyError } from "../lib/response";
import { defaultDisplayName } from "../lib/users";

/**
 * Records the nudge on the recipient's directory row, at most once per
 * sender per `NUDGE_INTERVAL_MS` (a conditional write: no extra table).
 * @returns "ok", "too-soon", or "unknown-user" when the recipient doesn't exist.
 */
async function claimNudge(from: string, to: string, now: number) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.users,
        Key: { userId: to },
        UpdateExpression: "SET #last = :now",
        ConditionExpression:
          "attribute_exists(userId) AND (attribute_not_exists(#last) OR #last < :cutoff)",
        ExpressionAttributeNames: { "#last": `nudgedAt_${from}` },
        ExpressionAttributeValues: { ":now": now, ":cutoff": now - NUDGE_INTERVAL_MS },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
    return "ok" as const;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return err.Item ? ("too-soon" as const) : ("unknown-user" as const);
    }
    throw err;
  }
}

async function displayNameOf(userId: string, email: string): Promise<string> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tables.users,
      Key: { userId },
      ProjectionExpression: "displayName",
    }),
  );
  return typeof Item?.displayName === "string" ? Item.displayName : defaultDisplayName(email);
}

/**
 * `nudge`: "look at me" to one person. Their open tabs get `user.nudge`
 * (toast + sound); with none open they get a Web Push. Nothing is stored in
 * the conversation.
 */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(NudgeActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { toUserId } = parsed.data;
  if (toUserId === caller.userId)
    return badRequest(caller.connectionId, "You can't nudge yourself");

  const claim = await claimNudge(caller.userId, toUserId, Date.now());
  if (claim === "unknown-user") return replyError(caller.connectionId, "USER_NOT_FOUND");
  if (claim === "too-soon") {
    return replyError(caller.connectionId, "RATE_LIMITED", "You already pinged them a moment ago");
  }

  const theirs = (await listConnections()).filter((c) => c.userId === toUserId);
  const reached = await deliver(theirs, () => ({ type: "user.nudge", from: caller.userId }));
  if (reached === 0) {
    const name = await displayNameOf(caller.userId, caller.userEmail);
    const dm = dmChannelId(caller.userId, toUserId);
    await sendPush([toUserId], {
      title: `👋 ${name} is pinging you`,
      body: "Open Slack to reply",
      url: `/app/${encodeURIComponent(dm)}`,
      // Tagged like the DM's messages: one notification per conversation.
      tag: dm,
      sound: "default",
    });
  }
  log.info("nudge", { from: caller.userId, to: toUserId, live: reached > 0 });
  return ok();
});
