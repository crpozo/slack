import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/tasks";
import type { HttpEvent } from "../src/lib/http";
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

beforeEach(() => {
  resetMocks();
  process.env.BOARDS_TABLE = BOARDS;
  process.env.TASKS_TABLE = TASKS;
  ddbMock.on(GetCommand, { TableName: BOARDS }).resolves({});
  ddbMock.on(GetCommand, { TableName: BOARDS, Key: { boardId: BOARD_ID, sk: "BOARD" } }).resolves({
    Item: boardRow,
  });
  ddbMock.on(GetCommand, { TableName: TASKS }).resolves({});
  ddbMock.on(GetCommand, { TableName: TASKS, Key: { taskId: "t_1" } }).resolves({ Item: task });
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
    expect(input?.UpdateExpression).toBe("SET #updatedAt = :updatedAt, #status = :status");
    expect(input?.ExpressionAttributeValues?.[":status"]).toBe("DONE");
    expect(input?.ConditionExpression).toBe("attribute_exists(taskId)");
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({
      type: "board.task_updated",
      boardId: BOARD_ID,
      task: { taskId: "t_1", status: "DONE" },
    });
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
