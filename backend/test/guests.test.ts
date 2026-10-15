import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { deliver } from "../src/lib/broadcast";
import { handler as presign } from "../src/handlers/presign";
import { handler as tasks } from "../src/handlers/tasks";
import type { HttpEvent } from "../src/lib/http";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const BOARD_ID = "b_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const GUEST = { userId: "user-guest", email: "client@acme.com", role: "guest" };

process.env.TASKS_TABLE = "slack-test-tasks";
process.env.USER_POOL_ID = "us-east-1_TEST";

function request(routeKey: string, body: unknown, groups?: string, user = ALICE): HttpEvent {
  const [method, path] = routeKey.split(" ");
  return {
    version: "2.0",
    routeKey,
    rawPath: path,
    headers: {},
    pathParameters: { id: BOARD_ID },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(groups && { "cognito:groups": groups }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
}
const call = async (...args: Parameters<typeof request>) => {
  const r = (await tasks(request(...args))) as { statusCode: number; body: string };
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};

const boardRow = {
  boardId: BOARD_ID,
  sk: "BOARD",
  name: "Website",
  ownerId: ALICE.userId,
  members: new Set([ALICE.userId]),
  createdAt: 1,
};

beforeEach(() => {
  resetMocks();
  cognitoMock.reset();
  ddbMock.on(GetCommand, { TableName: "slack-test-boards" }).resolves({ Item: boardRow });
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
    Items: [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-guest", userId: GUEST.userId, role: "guest" },
    ],
  });
});

describe("delivery filter", () => {
  it("a guest's connection only ever receives board events", async () => {
    const connections = [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-guest", userId: GUEST.userId, role: "guest" as const },
    ];
    await deliver(connections, () => ({ type: "user.connected", userId: BOB.userId }));
    await deliver(connections, () => ({ type: "board.deleted", boardId: BOARD_ID }));
    expect(sentEvents()).toEqual([
      ["conn-alice", { type: "user.connected", userId: BOB.userId }],
      ["conn-alice", { type: "board.deleted", boardId: BOARD_ID }],
      ["conn-guest", { type: "board.deleted", boardId: BOARD_ID }],
    ]);
  });
});

describe("presign for guests", () => {
  it("refuses channel files even in public channels", async () => {
    mockChannels(GENERAL);
    await presign(
      wsEvent(
        "presign",
        {
          action: "presign",
          op: "put",
          requestId: "r1",
          channelId: "ch_general",
          name: "a.png",
          contentType: "image/png",
          size: 10,
        },
        { user: GUEST, connectionId: "conn-guest" },
      ),
    );
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ type: "error" });
    expect(sentEvents().at(-1)?.[1]).not.toMatchObject({ type: "presign.result" });
  });
});

describe("board invites", () => {
  it("creates a guest account for a new email, groups it, and adds it to the board", async () => {
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: "sub", Value: GUEST.userId }] },
    });
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

    const { status, body } = await call("POST /boards/{id}/invites", {
      email: " Client@ACME.com ",
    });

    expect(status).toBe(200);
    expect(body.invited).toEqual({ userId: GUEST.userId, role: "guest", created: true });
    expect(body.board.members).toContain(GUEST.userId);
    const created = cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0].input;
    expect(created).toMatchObject({
      Username: "client@acme.com",
      DesiredDeliveryMediums: ["EMAIL"],
    });
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)[0]?.args[0].input.GroupName).toBe(
      "guests",
    );
    const row = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(row?.Key).toEqual({ userId: GUEST.userId });
    expect(row?.ExpressionAttributeValues?.[":role"]).toBe("guest");
    // Old and new members hear about it: the guest gains the board.
    expect(
      sentEvents()
        .map(([id]) => id)
        .sort(),
    ).toEqual(["conn-alice", "conn-guest"]);
  });

  it("deletes the new account if it can't be made a guest", async () => {
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: "sub", Value: GUEST.userId }] },
    });
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(new Error("throttled"));
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    const { status } = await call("POST /boards/{id}/invites", { email: GUEST.email });

    expect(status).toBe(500);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("adds an existing team member as they are, without emailing anyone", async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserStatus: "CONFIRMED",
      UserAttributes: [{ Name: "sub", Value: BOB.userId }],
    });
    cognitoMock.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });

    const { body } = await call("POST /boards/{id}/invites", { email: BOB.email });

    expect(body.invited).toEqual({ userId: BOB.userId, role: "member", created: false });
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it("re-sends the email to a guest who never set their password", async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserStatus: "FORCE_CHANGE_PASSWORD",
      UserAttributes: [{ Name: "sub", Value: GUEST.userId }],
    });
    cognitoMock.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: "guests" }] });
    cognitoMock.on(AdminCreateUserCommand).resolves({});

    await call("POST /boards/{id}/invites", { email: GUEST.email });

    expect(cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0].input.MessageAction).toBe(
      "RESEND",
    );
  });

  it("only the owner may invite, never a guest, and the email must be valid", async () => {
    expect(
      (await call("POST /boards/{id}/invites", { email: "x@y.ec" }, undefined, BOB)).status,
    ).toBe(
      404, // Bob isn't on the board at all
    );
    expect((await call("POST /boards/{id}/invites", { email: "not-an-email" })).status).toBe(400);
    expect(cognitoMock.calls()).toHaveLength(0);
  });

  it("guests can't create boards", async () => {
    const { status } = await call("POST /boards", { name: "Mine" }, "[guests]", GUEST);
    expect(status).toBe(403);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
