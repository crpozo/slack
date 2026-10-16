import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ARCHIVE_DONE_AFTER_MS } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/archive-tasks";
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

    expect(await handler()).toEqual({ archived: 2 });

    const scan = ddbMock.commandCalls(ScanCommand)[0]?.args[0].input;
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
    expect(await handler()).toEqual({ archived: 0 });
  });
});
