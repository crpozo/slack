import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EditActionSchema, parseAction, type Message } from "@mindfultech/shared";
import { broadcast } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { reindexLinks } from "../lib/media";
import { badRequest, ok, replyError } from "../lib/response";

type EditOutcome =
  | { ok: true; messageId: string; editedAt: number; before: Message }
  | { ok: false; code: "MESSAGE_NOT_FOUND" | "FORBIDDEN" };

/** Replaces the text if the message exists and the caller wrote it (one conditional write). */
async function applyEdit(
  key: { channelId: string; sk: string },
  userId: string,
  text: string,
): Promise<EditOutcome> {
  const editedAt = Date.now();
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.messages,
        Key: key,
        UpdateExpression: "SET #text = :text, isEdited = :yes, editedAt = :at",
        // A secret can't be edited (that would keep a credential past its week);
        // neither can a card (a meeting snapshot): the calendar event is the truth.
        ConditionExpression:
          "attribute_exists(sk) AND userId = :me AND attribute_not_exists(isSecret) AND attribute_not_exists(kind)",
        ExpressionAttributeNames: { "#text": "text" },
        ExpressionAttributeValues: { ":text": text, ":yes": true, ":at": editedAt, ":me": userId },
        // The message as it was: its old links leave the index (Phase 38).
        ReturnValues: "ALL_OLD",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
    return {
      ok: true,
      messageId: String(Attributes?.messageId ?? ""),
      editedAt,
      before: Attributes as Message,
    };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // The row came back: it exists, so it's someone else's. Nothing back: no such message.
    return { ok: false, code: err.Item ? "FORBIDDEN" : "MESSAGE_NOT_FOUND" };
  }
}

/** `edit`: change the text of one of your own messages and broadcast `message.updated`. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(EditActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId, sk, text } = parsed.data;

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");

  const outcome = await applyEdit({ channelId, sk }, caller.userId, text);
  if (!outcome.ok) {
    return replyError(
      caller.connectionId,
      outcome.code,
      outcome.code === "FORBIDDEN" ? "You can only edit your own messages" : undefined,
    );
  }
  log.info("message edited", { channelId, sk, userId: caller.userId });
  await reindexLinks({ ...outcome.before, channelId, sk }, text);

  const inAudience = channelAudience(channel);
  await broadcast((connection) =>
    inAudience(connection)
      ? {
          type: "message.updated",
          channelId,
          sk,
          messageId: outcome.messageId,
          text,
          isEdited: true,
          editedAt: outcome.editedAt,
        }
      : null,
  );
  return ok();
});
