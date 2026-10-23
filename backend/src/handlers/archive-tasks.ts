import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ARCHIVE_DONE_AFTER_MS } from "@mindfultech/shared";
import { purgeBoard } from "../lib/boardDeletion";
import { BOARD_SK } from "../lib/boards";
import { batchDelete, ddb, tables } from "../lib/ddb";
import { errorFields, log } from "../lib/logger";

/** A board stamped `deletingAt` this long ago whose cleanup didn't finish is finished here. */
export const STALE_DELETION_MS = 15 * 60_000;

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

/** Boards stamped `deletingAt` long enough ago that their own cleanup must have failed. */
async function staleDeletions(now: number): Promise<string[]> {
  const stale: string[] = [];
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: tables.boards,
      FilterExpression: "sk = :board AND attribute_exists(deletingAt)",
      ExpressionAttributeValues: { ":board": BOARD_SK },
      ProjectionExpression: "boardId, deletingAt",
    },
  )) {
    const due = (page.Items ?? []).filter(
      (item) => typeof item.deletingAt === "number" && item.deletingAt <= now - STALE_DELETION_MS,
    );
    stale.push(...due.map((item) => String(item.boardId)));
  }
  return stale;
}

/** Finishes those deletions; one failing never stops the others (tomorrow tries again). */
async function finishDeletions(boardIds: string[]): Promise<number> {
  const results = await Promise.allSettled(boardIds.map((boardId) => purgeBoard(boardId)));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      log.error("board purge failed again", {
        boardId: boardIds[i],
        ...errorFields(result.reason),
      });
    }
  });
  return results.filter((r) => r.status === "fulfilled").length;
}

/** Every task's id, grouped by its board. */
async function tasksByBoard(): Promise<Map<string, string[]>> {
  const byBoard = new Map<string, string[]>();
  for await (const page of paginateScan(
    { client: ddb },
    { TableName: tables.tasks, ProjectionExpression: "taskId, boardId" },
  )) {
    for (const item of page.Items ?? []) {
      if (typeof item.boardId !== "string") continue;
      byBoard.set(item.boardId, [...(byBoard.get(item.boardId) ?? []), String(item.taskId)]);
    }
  }
  return byBoard;
}

/**
 * Which of `boardIds` still have a board row. Keys DynamoDB didn't answer
 * (throttling) count as existing: tomorrow's run looks again.
 */
async function existingBoards(boardIds: string[]): Promise<Set<string>> {
  const chunks: string[][] = [];
  for (let i = 0; i < boardIds.length; i += 100) chunks.push(boardIds.slice(i, i + 100));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.boards]: {
              Keys: chunk.map((boardId) => ({ boardId, sk: BOARD_SK })),
              ProjectionExpression: "boardId",
            },
          },
        }),
      ),
    ),
  );
  const existing = new Set<string>();
  for (const { Responses, UnprocessedKeys } of pages) {
    for (const item of Responses?.[tables.boards] ?? []) existing.add(String(item.boardId));
    for (const key of UnprocessedKeys?.[tables.boards]?.Keys ?? []) {
      existing.add(String(key.boardId));
    }
  }
  return existing;
}

/** Tasks whose board is gone entirely (one created in the instant the board was being deleted). */
async function removeOrphanedTasks(): Promise<number> {
  const byBoard = await tasksByBoard();
  const existing = await existingBoards([...byBoard.keys()]);
  const orphans = [...byBoard]
    .filter(([boardId]) => !existing.has(boardId))
    .flatMap(([, taskIds]) => taskIds);
  await batchDelete(
    tables.tasks,
    orphans.map((taskId) => ({ taskId })),
  );
  return orphans.length;
}

/**
 * Phase 32's safety net for board deletion: finishes boards whose cleanup was
 * interrupted (stamped `deletingAt` a while ago), and removes tasks whose
 * board no longer exists at all.
 */
async function sweepDeletedBoards(now: number): Promise<{ purged: number; orphans: number }> {
  const purged = await finishDeletions(await staleDeletions(now));
  const orphans = await removeOrphanedTasks();
  if (purged > 0 || orphans > 0) log.info("deleted boards swept", { purged, orphans });
  return { purged, orphans };
}

/**
 * Daily (EventBridge schedule): archives tasks that have been Done for over a
 * week (nothing is deleted; archived tasks just drop off the board until
 * someone shows them; clients hide a task past the week on their own,
 * `isTaskArchived`, this only makes the flag stick), then sweeps up after
 * board deletions that didn't finish (Phase 32).
 */
export async function handler(): Promise<{ archived: number; purged: number; orphans: number }> {
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
  const swept = await sweepDeletedBoards(Date.now());
  return { archived, ...swept };
}
