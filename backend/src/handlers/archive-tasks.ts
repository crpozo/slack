import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ARCHIVE_DONE_AFTER_MS } from "@mindfultech/shared";
import { ddb, tables } from "../lib/ddb";
import { log } from "../lib/logger";

/** Flags one task archived; `false` if it was moved out of Done since the scan. */
async function archive({ taskId, doneAt }: { taskId: string; doneAt: number }): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.tasks,
        Key: { taskId },
        UpdateExpression: "SET isArchived = :yes, doneAt = if_not_exists(doneAt, :doneAt)",
        // Still done (nobody moved it back since the scan).
        ConditionExpression: "#status = :done",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":yes": true, ":done": "DONE", ":doneAt": doneAt },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/**
 * Daily (EventBridge schedule): archives tasks that have been Done for over a
 * week. Nothing is deleted; archived tasks just drop off the board until
 * someone shows them. Clients don't need a push: they hide a task past the
 * week on their own (`isTaskArchived`), this only makes the flag stick.
 */
export async function handler(): Promise<{ archived: number }> {
  const cutoff = Date.now() - ARCHIVE_DONE_AFTER_MS;
  const due: Array<{ taskId: string; doneAt: number }> = [];
  const pages = paginateScan(
    { client: ddb },
    {
      TableName: tables.tasks,
      ProjectionExpression: "taskId, doneAt, updatedAt",
      FilterExpression:
        "#status = :done AND (attribute_not_exists(isArchived) OR isArchived = :no)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":done": "DONE", ":no": false },
    },
  );
  for await (const page of pages) {
    for (const item of page.Items ?? []) {
      // Done before `doneAt` existed: its last change is the latest it could have been done.
      const doneAt = (item.doneAt ?? item.updatedAt) as number | undefined;
      if (doneAt !== undefined && doneAt <= cutoff) {
        due.push({ taskId: item.taskId as string, doneAt });
      }
    }
  }
  // Only tasks that crossed the week since the last run: a handful, updated in parallel.
  const results = await Promise.all(due.map(archive));
  const archived = results.filter(Boolean).length;
  log.info("done tasks archived", { archived });
  return { archived };
}
