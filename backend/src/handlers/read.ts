import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseAction, ReadActionSchema, type ReadMark } from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, replyError } from "../lib/response";

const isConditionFailure = (err: unknown) => err instanceof ConditionalCheckFailedException;
/** `SET reads.<user>` on a row without a `reads` map yet: DynamoDB rejects the path. */
const isMissingMap = (err: unknown) =>
  err instanceof Error && err.name === "ValidationException" && /document path/i.test(err.message);

/**
 * Moves the caller's watermark on the channel row forward to `mark.sk`. One
 * write per "I've seen up to here", whatever the number of messages: read
 * state is never stored per message.
 * @returns `false` when the watermark was already at or past `mark.sk`.
 */
async function advanceWatermark(
  channelId: string,
  userId: string,
  mark: ReadMark,
): Promise<boolean> {
  const update = (expression: string, condition: string, values: Record<string, unknown>) =>
    ddb.send(
      new UpdateCommand({
        TableName: tables.channels,
        Key: { channelId },
        UpdateExpression: expression,
        ConditionExpression: condition,
        // DynamoDB rejects names that no expression uses: `#u` only when the path has it.
        ExpressionAttributeNames: {
          "#reads": "reads",
          ...(`${expression} ${condition}`.includes("#u") && { "#u": userId }),
        },
        ExpressionAttributeValues: values,
      }),
    );
  try {
    await update(
      "SET #reads.#u = :mark",
      "attribute_exists(channelId) AND (attribute_not_exists(#reads.#u) OR #reads.#u.sk < :sk)",
      { ":mark": mark, ":sk": mark.sk },
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    if (!isMissingMap(err)) throw err;
  }
  // First read mark on this channel: create the map (unless someone just did).
  try {
    await update("SET #reads = :reads", "attribute_not_exists(#reads)", {
      ":reads": { [userId]: mark },
    });
    return true;
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
  try {
    await update("SET #reads.#u = :mark", "attribute_not_exists(#reads.#u) OR #reads.#u.sk < :sk", {
      ":mark": mark,
      ":sk": mark.sk,
    });
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/** `read`: the caller has seen `channelId` up to `sk`; tells the channel (`channel.read`). */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(ReadActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, sk } = parsed.data;

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");

  const mark: ReadMark = { sk, at: Date.now() };
  const moved = await advanceWatermark(channelId, caller.userId, mark);
  if (!moved) return ok(); // already read that far (another tab, or an out-of-order event)
  log.debug("read", { channelId, userId: caller.userId, sk });

  const inAudience = channelAudience(channel);
  await broadcast((connection) =>
    inAudience(connection)
      ? { type: "channel.read", channelId, userId: caller.userId, ...mark }
      : null,
  );
  return ok();
});
