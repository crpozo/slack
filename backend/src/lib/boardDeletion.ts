import { DeleteCommand, paginateQuery, paginateScan, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { attachmentPrefixFor, type Channel } from "@mindfultech/shared";
import { BOARD_SK } from "./boards";
import { batchDelete, ddb, tables } from "./ddb";
import { log } from "./logger";
import { deletePrefix } from "./s3";

// ---------------------------------------------------------------------------
// Deleting a board (Phase 32) happens in two phases. First the board row is
// stamped `deletingAt` (see `getAccessibleBoard`): from then on the board is
// gone for every route, so nothing new can be added to it. Then `purgeBoard`
// removes what it held — tasks, files, project-channel links, membership rows
// — and the board row last. If that's interrupted, the daily sweep
// (`archive-tasks`) runs `purgeBoard` again for boards stamped long enough
// ago; every step is idempotent.
// ---------------------------------------------------------------------------

export interface PurgeReport {
  tasks: number;
  files: number;
  /** Project channels that pointed at the board, as they are now (unlinked). */
  channels: Channel[];
}

async function boardTaskIds(boardId: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.tasks,
      IndexName: "byBoard",
      KeyConditionExpression: "boardId = :b",
      ExpressionAttributeValues: { ":b": boardId },
      ProjectionExpression: "taskId",
    },
  )) {
    for (const item of page.Items ?? []) ids.push(String(item.taskId));
  }
  return ids;
}

/** Project channels linked to the board stop being projects (the 📊 Board pill would lead nowhere). */
async function unlinkChannels(boardId: string): Promise<Channel[]> {
  const linked: Channel[] = [];
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: tables.channels,
      FilterExpression: "linkedBoardId = :b",
      ExpressionAttributeValues: { ":b": boardId },
    },
  )) {
    linked.push(...((page.Items ?? []) as Channel[]));
  }
  const updated: Channel[] = [];
  for (const channel of linked) {
    const { Attributes } = await ddb
      .send(
        new UpdateCommand({
          TableName: tables.channels,
          Key: { channelId: channel.channelId },
          UpdateExpression: "SET isProject = :no REMOVE linkedBoardId",
          ConditionExpression: "linkedBoardId = :b",
          ExpressionAttributeValues: { ":no": false, ":b": boardId },
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err: unknown) => {
        // Relinked to another board meanwhile: leave it.
        if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
          return { Attributes: undefined };
        }
        throw err;
      });
    if (Attributes) updated.push(Attributes as Channel);
  }
  return updated;
}

/** Everything a board stamped `deletingAt` still holds, then the board row itself. */
export async function purgeBoard(boardId: string): Promise<PurgeReport> {
  const taskIds = await boardTaskIds(boardId);
  await batchDelete(
    tables.tasks,
    taskIds.map((taskId) => ({ taskId })),
  );
  const files = await deletePrefix(attachmentPrefixFor(boardId));
  const channels = await unlinkChannels(boardId);

  const memberRows: Record<string, unknown>[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.boards,
      KeyConditionExpression: "boardId = :b",
      ExpressionAttributeValues: { ":b": boardId },
      ProjectionExpression: "boardId, sk",
    },
  )) {
    for (const item of page.Items ?? []) {
      if (item.sk !== BOARD_SK) memberRows.push({ boardId, sk: item.sk });
    }
  }
  await batchDelete(tables.boards, memberRows);
  await ddb.send(
    new DeleteCommand({
      TableName: tables.boards,
      Key: { boardId, sk: BOARD_SK },
      // Only a board whose deletion was decided: never one still in use.
      ConditionExpression: "attribute_not_exists(boardId) OR attribute_exists(deletingAt)",
    }),
  );
  log.info("board purged", { boardId, tasks: taskIds.length, files, channels: channels.length });
  return { tasks: taskIds.length, files, channels };
}
