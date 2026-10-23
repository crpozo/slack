import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ARCHIVE_DONE_AFTER_MS } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler, STALE_DELETION_MS } from "../src/handlers/archive-tasks";
import { ddbMock, resetMocks } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("archive-tasks", () => {
  beforeEach(() => {
    resetMocks();
    ddbMock.on(UpdateCommand).resolves({});
  });

  it("archives only tasks done for over a week, without deleting anything", async () => {
    const now = Date.now();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { taskId: "t_old", doneAt: now - ARCHIVE_DONE_AFTER_MS - DAY },
        { taskId: "t_recent", doneAt: now - DAY },
        { taskId: "t_legacy", updatedAt: now - 30 * DAY }, // done before doneAt existed
      ],
    });

    expect(await handler()).toEqual({ archived: 2, purged: 0, orphans: 0 });

    const scan = ddbMock.commandCalls(ScanCommand, { TableName: "slack-test-tasks" })[0]?.args[0]
      .input;
    expect(scan).toMatchObject({
      TableName: "slack-test-tasks",
      ExpressionAttributeValues: { ":done": "DONE", ":no": false },
    });
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.map((u) => u.Key)).toEqual([{ taskId: "t_old" }, { taskId: "t_legacy" }]);
    expect(updates[0]).toMatchObject({
      ConditionExpression: "#status = :done",
      ExpressionAttributeValues: { ":yes": true },
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("skips a task moved out of Done since the scan", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ taskId: "t_old", doneAt: 1 }] });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "moved", $metadata: {} }));
    expect(await handler()).toEqual({ archived: 0, purged: 0, orphans: 0 });
  });

  describe("sweeping up after board deletions (Phase 32)", () => {
    const s3Mock = mockClient(S3Client);
    const BOARDS = "slack-test-boards";
    beforeEach(() => {
      s3Mock.reset();
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(DeleteObjectsCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(BatchWriteCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({ Items: [] });
    });

    it("finishes boards whose deletion was interrupted a while ago, not ones in progress", async () => {
      const now = Date.now();
      ddbMock.on(ScanCommand, { TableName: BOARDS }).resolves({
        Items: [
          { boardId: "b_stuck", deletingAt: now - STALE_DELETION_MS - 1000 },
          { boardId: "b_busy", deletingAt: now - 1000 },
        ],
      });
      const result = await handler();
      expect(result.purged).toBe(1);
      const deletes = ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key);
      expect(deletes).toEqual([{ boardId: "b_stuck", sk: "BOARD" }]);
    });

    it("deletes tasks whose board no longer exists", async () => {
      ddbMock.on(ScanCommand, { TableName: "slack-test-tasks" }).callsFake((input) =>
        input.ProjectionExpression === "taskId, boardId"
          ? {
              Items: [
                { taskId: "t_1", boardId: "b_live" },
                { taskId: "t_2", boardId: "b_gone" },
                { taskId: "t_3", boardId: "b_gone" },
              ],
            }
          : { Items: [] },
      );
      ddbMock.on(BatchGetCommand).resolves({ Responses: { [BOARDS]: [{ boardId: "b_live" }] } });
      expect((await handler()).orphans).toBe(2);
      const batch = ddbMock.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!;
      expect(batch["slack-test-tasks"]).toEqual([
        { DeleteRequest: { Key: { taskId: "t_2" } } },
        { DeleteRequest: { Key: { taskId: "t_3" } } },
      ]);
    });
  });
});
