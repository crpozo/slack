import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handler } from "../src/handlers/tasks";
import type { HttpEvent } from "../src/lib/http";
import * as push from "../src/lib/push";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents } from "./helpers";

const CAROL = { userId: "user-carol", email: "carol@example.com" };
const BOARD_ID = "b_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const connections = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
  { connectionId: "conn-carol", userId: CAROL.userId },
];
/** Connection ids that received a board.* push. */
const pushed = () =>
  sentEvents()
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
const BOARDS = "slack-test-boards";
const TASKS = "slack-test-tasks";

/** An API Gateway v2 event as the JWT authorizer hands it over. */
function request(
  routeKey: string,
  opts: {
    user?: { userId: string; email: string };
    params?: Record<string, string>;
    body?: unknown;
  } = {},
): HttpEvent {
  const user = opts.user ?? ALICE;
  const [method, path] = routeKey.split(" ");
  return {
    version: "2.0",
    routeKey,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    pathParameters: opts.params,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path },
      authorizer: { jwt: { claims: { sub: user.userId, email: user.email }, scopes: [] } },
    },
  } as unknown as HttpEvent;
}

const call = async (...args: Parameters<typeof request>) => {
  const result = (await handler(request(...args))) as { statusCode: number; body: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};

const boardRow = {
  boardId: BOARD_ID,
  sk: "BOARD",
  name: "Launch",
  ownerId: ALICE.userId,
  members: new Set([ALICE.userId, BOB.userId]),
  createdAt: 10,
};
const task = {
  taskId: "t_1",
  boardId: BOARD_ID,
  title: "Write docs",
  description: "",
  status: "TODO",
  assigneeId: null,
  project: "",
  notes: "",
  attachments: [],
  createdBy: BOB.userId,
  createdAt: 20,
  updatedAt: 20,
};

let sendPush: MockInstance<typeof push.sendPush>;

beforeEach(() => {
  resetMocks();
  sendPush = vi.spyOn(push, "sendPush").mockResolvedValue(1);
  process.env.BOARDS_TABLE = BOARDS;
  process.env.TASKS_TABLE = TASKS;
  ddbMock.on(GetCommand, { TableName: BOARDS }).resolves({});
  ddbMock.on(GetCommand, { TableName: BOARDS, Key: { boardId: BOARD_ID, sk: "BOARD" } }).resolves({
    Item: boardRow,
  });
  ddbMock.on(GetCommand, { TableName: TASKS }).resolves({});
  ddbMock.on(GetCommand, { TableName: TASKS, Key: { taskId: "t_1" } }).resolves({ Item: task });
  ddbMock.on(GetCommand, { TableName: "slack-test-users" }).resolves({}); // default display names
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({ Items: connections });
});

describe("boards", () => {
  it("lists the boards the caller belongs to, members as sorted arrays", async () => {
    ddbMock
      .on(QueryCommand, { TableName: BOARDS, IndexName: "byUser" })
      .resolves({ Items: [{ boardId: BOARD_ID }, { boardId: "b_2" }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        [BOARDS]: [
          { ...boardRow, createdAt: 10 },
          {
            boardId: "b_2",
            sk: "BOARD",
            name: "Older",
            ownerId: BOB.userId,
            members: new Set([BOB.userId, ALICE.userId]),
            createdAt: 5,
          },
        ],
      },
    });

    const { status, body } = await call("GET /boards");

    expect(status).toBe(200);
    expect(body.boards.map((b: { boardId: string }) => b.boardId)).toEqual(["b_2", BOARD_ID]);
    expect(body.boards[1]).toEqual({
      boardId: BOARD_ID,
      name: "Launch",
      ownerId: ALICE.userId,
      members: [ALICE.userId, BOB.userId],
      createdAt: 10,
    });
    const query = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(query?.ExpressionAttributeValues).toEqual({ ":me": ALICE.userId });
  });

  it("creates a board owned by the caller with a membership row, in one transaction", async () => {
    const { status, body } = await call("POST /boards", { body: { name: "  Roadmap " } });

    expect(status).toBe(201);
    expect(body.board).toMatchObject({
      name: "Roadmap",
      ownerId: ALICE.userId,
      members: [ALICE.userId],
    });
    expect(body.board.boardId).toMatch(/^b_[0-9A-Z]{26}$/);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Put?.Item).toMatchObject({ sk: "BOARD", members: new Set([ALICE.userId]) });
    expect(items[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(boardId)");
    expect(items[1]?.Put?.Item).toMatchObject({
      sk: `MEMBER#${ALICE.userId}`,
      userId: ALICE.userId,
    });
  });

  it("rejects an empty or invalid board name with 400", async () => {
    expect((await call("POST /boards", { body: { name: "   " } })).status).toBe(400);
    expect((await call("POST /boards", { body: "not json {" })).status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("the owner can add existing users; the board row is the authority and gets ADD members", async () => {
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { "slack-test-users": [{ userId: CAROL.userId }] } });

    const { status, body } = await call("POST /boards/{id}/members", {
      params: { id: BOARD_ID },
      body: { userIds: [CAROL.userId, BOB.userId, CAROL.userId] }, // BOB already a member
    });

    expect(status).toBe(200);
    expect(body.board.members).toEqual([ALICE.userId, BOB.userId, CAROL.userId]);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items[0]?.Update).toMatchObject({
      Key: { boardId: BOARD_ID, sk: "BOARD" },
      UpdateExpression: "ADD members :ids",
      ConditionExpression: "ownerId = :me",
      ExpressionAttributeValues: { ":ids": new Set([CAROL.userId]), ":me": ALICE.userId },
    });
    expect(items).toHaveLength(2); // one membership row for the one new member
    expect(items[1]?.Put?.Item).toMatchObject({ sk: `MEMBER#${CAROL.userId}` });
    // Everyone, the newcomer included, learns about the board without a reload.
    expect(pushed()).toEqual(["conn-alice", "conn-bob", "conn-carol"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({
      type: "board.updated",
      board: { boardId: BOARD_ID },
    });
  });

  it("the owner renames the board and every member hears about it", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { status, body } = await call("PUT /boards/{id}", {
      params: { id: BOARD_ID },
      body: { name: "  Launch v2 " },
    });
    expect(status).toBe(200);
    expect(body.board).toMatchObject({ boardId: BOARD_ID, name: "Launch v2" });
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ boardId: BOARD_ID, sk: "BOARD" });
    expect(input?.ConditionExpression).toBe("ownerId = :me");
    expect(input?.ExpressionAttributeValues).toEqual({ ":name": "Launch v2", ":me": ALICE.userId });
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({
      type: "board.updated",
      board: { name: "Launch v2" },
    });
  });

  it("members who are not the owner cannot rename; blank names are refused", async () => {
    const bob = await call("PUT /boards/{id}", {
      user: BOB,
      params: { id: BOARD_ID },
      body: { name: "x" },
    });
    expect(bob.status).toBe(403);
    const blank = await call("PUT /boards/{id}", {
      params: { id: BOARD_ID },
      body: { name: "   " },
    });
    expect(blank.status).toBe(400);
    const outsider = await call("PUT /boards/{id}", {
      user: CAROL,
      params: { id: BOARD_ID },
      body: { name: "x" },
    });
    expect(outsider.status).toBe(404);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("the owner deletes the board: tasks, then membership rows, then the board row", async () => {
    ddbMock
      .on(QueryCommand, { TableName: TASKS, IndexName: "byBoard" })
      .resolves({ Items: [task, { ...task, taskId: "t_2" }] });
    ddbMock
      .on(QueryCommand, { TableName: BOARDS, KeyConditionExpression: "boardId = :b" })
      .resolves({
        Items: [
          { boardId: BOARD_ID, sk: "BOARD" },
          { boardId: BOARD_ID, sk: `MEMBER#${ALICE.userId}` },
          { boardId: BOARD_ID, sk: `MEMBER#${BOB.userId}` },
        ],
      });
    ddbMock.on(BatchWriteCommand).resolves({});

    const { status } = await call("DELETE /boards/{id}", { params: { id: BOARD_ID } });

    expect(status).toBe(204);
    const [tasksBatch, membersBatch] = ddbMock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems);
    expect(tasksBatch?.[TASKS]).toEqual([
      { DeleteRequest: { Key: { taskId: "t_1" } } },
      { DeleteRequest: { Key: { taskId: "t_2" } } },
    ]);
    expect(membersBatch?.[BOARDS]).toEqual([
      { DeleteRequest: { Key: { boardId: BOARD_ID, sk: `MEMBER#${ALICE.userId}` } } },
      { DeleteRequest: { Key: { boardId: BOARD_ID, sk: `MEMBER#${BOB.userId}` } } },
    ]);
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input).toMatchObject({
      TableName: BOARDS,
      Key: { boardId: BOARD_ID, sk: "BOARD" },
      ConditionExpression: "ownerId = :me",
    });
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]?.[1]).toEqual({ type: "board.deleted", boardId: BOARD_ID });
  });

  it("only the owner can delete a board; outsiders get 404", async () => {
    expect(
      (await call("DELETE /boards/{id}", { user: BOB, params: { id: BOARD_ID } })).status,
    ).toBe(403);
    expect(
      (await call("DELETE /boards/{id}", { user: CAROL, params: { id: BOARD_ID } })).status,
    ).toBe(404);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("keeps the board row when its tasks can't all be deleted", async () => {
    ddbMock
      .on(QueryCommand, { TableName: TASKS, IndexName: "byBoard" })
      .resolves({ Items: [task] });
    ddbMock.on(BatchWriteCommand).resolves({
      UnprocessedItems: { [TASKS]: [{ DeleteRequest: { Key: { taskId: "t_1" } } }] },
    });

    const { status } = await call("DELETE /boards/{id}", { params: { id: BOARD_ID } });

    expect(status).toBe(500);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([]);
  });

  it("a member who is not the owner gets 403 when adding people", async () => {
    const { status, body } = await call("POST /boards/{id}/members", {
      user: BOB,
      params: { id: BOARD_ID },
      body: { userIds: [CAROL.userId] },
    });
    expect(status).toBe(403);
    expect(body.message).toMatch(/owner/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("refuses unknown invitees", async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { "slack-test-users": [] } });
    const { status, body } = await call("POST /boards/{id}/members", {
      params: { id: BOARD_ID },
      body: { userIds: ["user-nobody"] },
    });
    expect(status).toBe(400);
    expect(body.message).toBe("Unknown users: user-nobody");
  });
});

describe("tasks", () => {
  it("lists a board's tasks for a member, following pagination", async () => {
    ddbMock
      .on(QueryCommand, { TableName: TASKS, IndexName: "byBoard" })
      .resolvesOnce({ Items: [task], LastEvaluatedKey: { taskId: "t_1" } })
      .resolvesOnce({ Items: [{ ...task, taskId: "t_2" }] });

    const { status, body } = await call("GET /boards/{id}/tasks", {
      user: BOB,
      params: { id: BOARD_ID },
    });

    expect(status).toBe(200);
    expect(body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["t_1", "t_2"]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it("creates a task in TODO, stamped with the creator", async () => {
    const { status, body } = await call("POST /boards/{id}/tasks", {
      user: BOB,
      params: { id: BOARD_ID },
      body: { title: " Ship v0.2 ", description: "Tag and announce" },
    });

    expect(status).toBe(201);
    expect(body.task).toMatchObject({
      boardId: BOARD_ID,
      title: "Ship v0.2",
      description: "Tag and announce",
      status: "TODO",
      createdBy: BOB.userId,
    });
    expect(body.task).toMatchObject({ assigneeId: null, project: "", notes: "", attachments: [] });
    expect(body.task.taskId).toMatch(/^t_[0-9A-Z]{26}$/);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(taskId)",
    );
    // Pushed to the board's members only (carol is not on the board).
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "board.task_created", boardId: BOARD_ID });
  });

  it("accepts the detail fields: assignee, project, notes and board attachments", async () => {
    const attachment = {
      key: `attachments/${BOARD_ID}/01HZZ-brief.pdf`,
      name: "brief.pdf",
      size: 1234,
      contentType: "application/pdf",
    };
    const { status, body } = await call("POST /boards/{id}/tasks", {
      params: { id: BOARD_ID },
      body: {
        title: "Brief",
        assigneeId: BOB.userId,
        project: " Website ",
        notes: "See the brief",
        attachments: [attachment],
      },
    });
    expect(status).toBe(201);
    expect(body.task).toMatchObject({
      assigneeId: BOB.userId,
      project: "Website",
      notes: "See the brief",
      attachments: [attachment],
    });
  });

  it("rejects an assignee who is not on the board and files from another folder", async () => {
    const outsider = await call("POST /boards/{id}/tasks", {
      params: { id: BOARD_ID },
      body: { title: "x", assigneeId: CAROL.userId },
    });
    expect(outsider.status).toBe(400);
    expect(outsider.body.message).toMatch(/member of the board/);

    for (const key of ["attachments/ch_general/01HZZ-leak.png", `attachments/${BOARD_ID}/../x`]) {
      const foreign = await call("PUT /tasks/{taskId}", {
        params: { taskId: "t_1" },
        body: { attachments: [{ key, name: "x", size: 1, contentType: "image/png" }] },
      });
      expect(foreign.status, key).toBe(400);
      expect(foreign.body.message).toMatch(/uploaded to this board/);
    }
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([]);
  });

  it("fills in the detail fields for tasks stored before they existed", async () => {
    const legacy = {
      taskId: "t_old",
      boardId: BOARD_ID,
      title: "Old",
      description: "",
      status: "DONE",
      createdBy: ALICE.userId,
      createdAt: 1,
      updatedAt: 1,
    };
    ddbMock
      .on(QueryCommand, { TableName: TASKS, IndexName: "byBoard" })
      .resolves({ Items: [legacy] });
    const { body } = await call("GET /boards/{id}/tasks", { params: { id: BOARD_ID } });
    expect(body.tasks[0]).toEqual({
      ...legacy,
      assigneeId: null,
      project: "",
      notes: "",
      attachments: [],
      doneAt: 1, // done since its last change at the latest
      isArchived: false,
    });
  });

  it("updates only the given fields and bumps updatedAt", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...task, status: "DONE", updatedAt: 99 } });

    const { status, body } = await call("PUT /tasks/{taskId}", {
      user: BOB,
      params: { taskId: "t_1" },
      body: { status: "DONE" },
    });

    expect(status).toBe(200);
    expect(body.task.status).toBe("DONE");
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toBe(
      "SET #updatedAt = :updatedAt, #status = :status, #doneAt = :doneAt, #isArchived = :isArchived",
    );
    expect(input?.ExpressionAttributeValues?.[":status"]).toBe("DONE");
    // Moving into Done starts the archive clock.
    expect(input?.ExpressionAttributeValues?.[":doneAt"]).toBe(
      input?.ExpressionAttributeValues?.[":updatedAt"],
    );
    expect(input?.ConditionExpression).toBe("attribute_exists(taskId)");
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({
      type: "board.task_updated",
      boardId: BOARD_ID,
      task: { taskId: "t_1", status: "DONE" },
    });
  });

  it("moving a task out of Done stops the archive clock and unarchives it", async () => {
    ddbMock.on(GetCommand, { TableName: TASKS, Key: { taskId: "t_1" } }).resolves({
      Item: { ...task, status: "DONE", doneAt: 5, isArchived: true },
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...task, status: "TODO" } });
    await call("PUT /tasks/{taskId}", { params: { taskId: "t_1" }, body: { status: "TODO" } });
    const values = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues;
    expect(values).toMatchObject({ ":doneAt": null, ":isArchived": false });
  });

  it("other edits leave a done task's archive clock alone", async () => {
    ddbMock.on(GetCommand, { TableName: TASKS, Key: { taskId: "t_1" } }).resolves({
      Item: { ...task, status: "DONE", doneAt: 5 },
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...task, status: "DONE", title: "x" } });
    await call("PUT /tasks/{taskId}", {
      params: { taskId: "t_1" },
      body: { title: "x", status: "DONE" },
    });
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).not.toContain("doneAt");
  });

  it("assigneeId: null unassigns", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...task, assigneeId: null } });
    const { status } = await call("PUT /tasks/{taskId}", {
      params: { taskId: "t_1" },
      body: { assigneeId: null },
    });
    expect(status).toBe(200);
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toBe("SET #updatedAt = :updatedAt, #assigneeId = :assigneeId");
    expect(input?.ExpressionAttributeValues?.[":assigneeId"]).toBeNull();
  });

  it("rejects an empty update and an unknown status", async () => {
    expect(
      (await call("PUT /tasks/{taskId}", { params: { taskId: "t_1" }, body: {} })).status,
    ).toBe(400);
    expect(
      (await call("PUT /tasks/{taskId}", { params: { taskId: "t_1" }, body: { status: "LATER" } }))
        .status,
    ).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("deletes a task on an accessible board and tells the members", async () => {
    const { status } = await call("DELETE /tasks/{taskId}", { params: { taskId: "t_1" } });
    expect(status).toBe(204);
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual({ taskId: "t_1" });
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]?.[1]).toEqual({
      type: "board.task_deleted",
      boardId: BOARD_ID,
      taskId: "t_1",
    });
  });

  it("a failed push never fails the request", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).rejects(new Error("ddb down"));
    const { status } = await call("DELETE /tasks/{taskId}", { params: { taskId: "t_1" } });
    expect(status).toBe(204);
  });
});

describe("board activity notifications", () => {
  it("a new task pushes to the other members, titled by board and actor", async () => {
    await call("POST /boards/{id}/tasks", {
      user: BOB,
      params: { id: BOARD_ID },
      body: { title: "Ship v0.2" },
    });
    expect(sentEvents()[0]?.[1]).toMatchObject({ by: BOB.userId, boardName: "Launch" });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const [recipients, payload] = sendPush.mock.calls[0] ?? [];
    expect(recipients).toEqual([ALICE.userId]); // never the actor (Bob), never Carol
    expect(payload).toMatchObject({
      title: "Launch",
      body: "bob added “Ship v0.2” to To Do",
      url: `/app/tasks/${BOARD_ID}`,
      sound: "default",
    });
  });

  it("moving a task to another column pushes the move; other edits don't", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...task, status: "IN_PROGRESS" } });
    await call("PUT /tasks/{taskId}", {
      params: { taskId: "t_1" },
      body: { status: "IN_PROGRESS" },
    });
    expect(sentEvents()[0]?.[1]).toMatchObject({
      type: "board.task_updated",
      by: ALICE.userId,
      previousStatus: "TODO",
    });
    expect(sendPush).toHaveBeenCalledWith([BOB.userId], {
      title: "Launch",
      body: "alice moved “Write docs” from To Do to In Progress",
      url: `/app/tasks/${BOARD_ID}`,
      tag: "t_1",
      sound: "default",
    });

    sendPush.mockClear();
    resetMocks();
    ddbMock
      .on(GetCommand, { TableName: BOARDS, Key: { boardId: BOARD_ID, sk: "BOARD" } })
      .resolves({
        Item: boardRow,
      });
    ddbMock.on(GetCommand, { TableName: TASKS, Key: { taskId: "t_1" } }).resolves({ Item: task });
    ddbMock.on(GetCommand, { TableName: "slack-test-users" }).resolves({});
    ddbMock.on(ScanCommand).resolves({ Items: connections });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...task, title: "Renamed" } });
    await call("PUT /tasks/{taskId}", { params: { taskId: "t_1" }, body: { title: "Renamed" } });
    expect(sentEvents()[0]?.[1]).not.toHaveProperty("previousStatus");
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("skips members who are in front of the app right now", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [{ connectionId: "conn-alice", userId: ALICE.userId, activeAt: Date.now() }],
    });
    await call("POST /boards/{id}/tasks", {
      user: BOB,
      params: { id: BOARD_ID },
      body: { title: "Ship v0.2" },
    });
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe("board permissions", () => {
  it("non-members get 404 for the board, its tasks and its tasks by id, never 403", async () => {
    const asCarol = { user: CAROL };
    expect(
      (await call("GET /boards/{id}/tasks", { ...asCarol, params: { id: BOARD_ID } })).status,
    ).toBe(404);
    expect(
      (
        await call("POST /boards/{id}/tasks", {
          ...asCarol,
          params: { id: BOARD_ID },
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST /boards/{id}/members", {
          ...asCarol,
          params: { id: BOARD_ID },
          body: { userIds: ["u"] },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("PUT /tasks/{taskId}", {
          ...asCarol,
          params: { taskId: "t_1" },
          body: { status: "DONE" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE /tasks/{taskId}", { ...asCarol, params: { taskId: "t_1" } })).status,
    ).toBe(404);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("missing boards and tasks are 404 too", async () => {
    expect((await call("GET /boards/{id}/tasks", { params: { id: "b_404" } })).status).toBe(404);
    expect((await call("DELETE /tasks/{taskId}", { params: { taskId: "t_404" } })).status).toBe(
      404,
    );
  });

  it("a request without a verified subject is 401 and an unknown route 404", async () => {
    const event = request("GET /boards");
    (event.requestContext as { authorizer?: unknown }).authorizer = undefined;
    const result = (await handler(event)) as { statusCode: number };
    expect(result.statusCode).toBe(401);
    expect((await call("GET /nothing")).status).toBe(404);
  });
});

describe("POST /boards/{id}/tasks/from-notes", () => {
  const DM = "dm_user-alice_user-bob";
  const MESSAGES = "slack-test-messages";
  const ENDED = Date.UTC(2026, 9, 22, 15, 12, 34);
  const notesCard = (patch: Record<string, unknown> = {}) => ({
    messageId: "m-notes",
    channelId: DM,
    sk: "100#m-notes",
    userId: ALICE.userId,
    text: "✨ AI call notes: done",
    kind: "ai_notes",
    aiNotes: {
      callId: "c1",
      status: "ready",
      summary: "## Action Items\n- one",
      startedAt: ENDED - 754_000,
      endedAt: ENDED,
      participants: [ALICE.userId, BOB.userId],
      ...patch,
    },
  });
  const send = (body: Record<string, unknown> = {}, user = ALICE) =>
    call("POST /boards/{id}/tasks/from-notes", {
      user,
      params: { id: BOARD_ID },
      body: {
        channelId: DM,
        sk: "100#m-notes",
        tasks: [
          { title: "Send the release notes", assigneeId: ALICE.userId },
          { title: "Review the budget", description: "check hosting · confirm with finance" },
        ],
        ...body,
      },
    });

  beforeEach(() => {
    ddbMock.on(GetCommand, { TableName: "slack-test-channels" }).resolves({
      Item: { channelId: DM, type: "dm", members: [ALICE.userId, BOB.userId], name: DM },
    });
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({ Item: notesCard() });
    ddbMock
      .on(GetCommand, { TableName: "slack-test-users", Key: { userId: BOB.userId } })
      .resolves({ Item: { userId: BOB.userId, displayName: "Bob B." } });
  });

  it("claims the card and creates every task in one transaction, in the notes' order", async () => {
    const { status, body } = await send();
    expect(status).toBe(201);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(3);
    expect(items[0]!.Update).toMatchObject({
      TableName: MESSAGES,
      Key: { channelId: DM, sk: "100#m-notes" },
      ConditionExpression:
        "kind = :kind AND aiNotes.#status = :ready AND attribute_not_exists(aiNotes.sentToBoard)",
      ExpressionAttributeValues: {
        ":sent": { boardId: BOARD_ID, boardName: "Launch", count: 2, by: ALICE.userId },
      },
    });
    const [first, second] = items.slice(1).map((i) => i.Put!.Item as Record<string, unknown>);
    expect(first).toMatchObject({
      boardId: BOARD_ID,
      title: "Send the release notes",
      status: "TODO",
      assigneeId: ALICE.userId,
      createdBy: ALICE.userId,
      notes: "From ✨ AI call notes: call with Bob B. on 2026-10-22 (12:34).",
    });
    expect(second).toMatchObject({
      assigneeId: null,
      description: "check hosting · confirm with finance",
    });
    expect(Number(second!.createdAt)).toBe(Number(first!.createdAt) + 1);
    expect(body.notes.sentToBoard).toMatchObject({ boardId: BOARD_ID, count: 2 });
    expect(body.tasks).toHaveLength(2);
  });

  it("updates the board task by task, the card for both people, and pushes once", async () => {
    await send();
    const events = sentEvents();
    const created = events.filter(([, e]) => e.type === "board.task_created");
    // Alice and Bob are on the board; two tasks each, marked as one batch.
    expect(created.map(([id, e]) => [id, (e as { batch?: unknown }).batch])).toEqual([
      ["conn-alice", { index: 0, size: 2 }],
      ["conn-bob", { index: 0, size: 2 }],
      ["conn-alice", { index: 1, size: 2 }],
      ["conn-bob", { index: 1, size: 2 }],
    ]);
    const cardUpdates = events.filter(([, e]) => e.type === "message.updated");
    expect(cardUpdates.map(([id]) => id)).toEqual(["conn-alice", "conn-bob"]);
    expect(cardUpdates[0]![1]).toMatchObject({
      channelId: DM,
      sk: "100#m-notes",
      text: "✨ AI call notes: done",
      aiNotes: { sentToBoard: { boardName: "Launch", count: 2 } },
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0]![1]).toMatchObject({
      title: "Launch",
      body: "alice added 2 tasks from ✨ AI call notes to To Do",
    });
  });

  it("refuses a second send (409), including one that loses the race in the transaction", async () => {
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({
      Item: notesCard({ sentToBoard: { boardId: BOARD_ID, boardName: "Launch", count: 1 } }),
    });
    const already = await send();
    expect(already.status).toBe(409);
    expect(already.body.message).toBe("Already sent to Launch");

    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({ Item: notesCard() });
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      }),
    );
    const raced = await send({}, BOB);
    expect(raced.status).toBe(409);
    expect(sentEvents()).toEqual([]);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("only for ready notes you can see, on a board you're on, with members as assignees", async () => {
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({
      Item: notesCard({ status: "pending" }),
    });
    expect((await send()).status).toBe(409);
    ddbMock
      .on(GetCommand, { TableName: MESSAGES })
      .resolves({ Item: { ...notesCard(), kind: undefined } });
    expect((await send()).status).toBe(404);
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({ Item: notesCard() });
    expect((await send({}, CAROL)).status).toBe(404); // not on the board
    expect((await send({ tasks: [{ title: "x", assigneeId: CAROL.userId }] })).status).toBe(400);
    expect((await send({ tasks: [] })).status).toBe(400);
    ddbMock.on(GetCommand, { TableName: "slack-test-channels" }).resolves({});
    expect((await send()).status).toBe(404); // not in the conversation
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
