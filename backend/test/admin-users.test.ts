import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UserNotFoundException,
  type UserStatusType,
} from "@aws-sdk/client-cognito-identity-provider";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { TeamMember } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/admin-users";
import type { HttpEvent } from "../src/lib/http";
import { ddbMock, resetMocks } from "./helpers";

const cognito = mockClient(CognitoIdentityProviderClient);
const ADMIN = { userId: "aaaaaaaa-0000-4000-8000-000000000001", email: "carlos@mt.ec" };
const STAFF = { userId: "bbbbbbbb-0000-4000-8000-000000000002", email: "ana@mt.ec" };
const NEW = "cccccccc-0000-4000-8000-000000000003";

function request(
  routeKey: string,
  body?: unknown,
  user = ADMIN,
  groups = user === ADMIN ? "[admins]" : "",
  params: Record<string, string> = {},
): HttpEvent {
  return {
    routeKey,
    pathParameters: params,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: user.userId, email: user.email, "cognito:groups": groups } },
      },
    },
  } as unknown as HttpEvent;
}
async function call(...args: Parameters<typeof request>) {
  const r = (await handler(request(...args))) as { statusCode: number; body?: string };
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
}

beforeEach(() => {
  resetMocks();
  cognito.reset();
  process.env.USER_POOL_ID = "us-east-1_TEST";
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  cognito
    .on(AdminGetUserCommand)
    .rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
  cognito.on(AdminCreateUserCommand).resolves({
    User: {
      Username: NEW,
      Attributes: [{ Name: "sub", Value: NEW }],
      UserCreateDate: new Date(1_700_000_000_000),
    },
  });
  cognito.on(AdminAddUserToGroupCommand).resolves({});
});

describe("the team panel is for admins", () => {
  it("staff and guests are refused, before anything is read or created", async () => {
    expect((await call("GET /admin/users", undefined, STAFF)).status).toBe(403);
    expect((await call("POST /admin/users", { email: "x@mt.ec" }, STAFF, "[guests]")).status).toBe(
      403,
    );
    expect(cognito.calls()).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("inviting someone", () => {
  it("as staff: Cognito creates and emails the account; the profile goes in users with the role", async () => {
    const { status, body } = await call("POST /admin/users", {
      email: " Luis@MT.ec ",
      displayName: "Luis",
    });
    expect(status).toBe(201);
    expect(body.member).toMatchObject({
      userId: NEW,
      email: "luis@mt.ec",
      displayName: "Luis",
      role: "member",
      status: "invited",
    });
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({
      UserPoolId: "us-east-1_TEST",
      Username: "luis@mt.ec",
      DesiredDeliveryMediums: ["EMAIL"],
      UserAttributes: expect.arrayContaining([
        { Name: "email", Value: "luis@mt.ec" },
        { Name: "email_verified", Value: "true" },
      ]),
    });
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      TableName: "slack-test-users",
      Item: {
        userId: NEW,
        email: "luis@mt.ec",
        displayName: "Luis",
        role: "member",
        invitedBy: ADMIN.userId,
      },
      ConditionExpression: "attribute_not_exists(userId)",
    });
  });

  it("as admin: put in the admins group before they can sign in", async () => {
    const { body } = await call("POST /admin/users", { email: "eva@mt.ec", role: "admin" });
    expect(body.member).toMatchObject({ role: "admin", displayName: "eva" });
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input).toMatchObject({
      Username: NEW,
      GroupName: "admins",
    });
  });

  it("if the admins group can't be set, the account is deleted and nothing is stored", async () => {
    cognito.on(AdminAddUserToGroupCommand).rejects(new Error("throttled"));
    cognito.on(AdminDeleteUserCommand).resolves({});
    expect((await call("POST /admin/users", { email: "eva@mt.ec", role: "admin" })).status).toBe(
      500,
    );
    expect(cognito.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input).toMatchObject({
      Username: NEW,
    });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("an email that already has an account: 409, nothing created", async () => {
    cognito.on(AdminGetUserCommand).resolves({
      Username: STAFF.userId,
      UserAttributes: [{ Name: "sub", Value: STAFF.userId }],
    });
    cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
    const { status, body } = await call("POST /admin/users", { email: STAFF.email });
    expect(status).toBe(409);
    expect(body.message).toMatch(/already has an account/);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it("refuses a malformed email or role", async () => {
    expect((await call("POST /admin/users", { email: "nope" })).status).toBe(400);
    expect((await call("POST /admin/users", { email: "x@mt.ec", role: "guest" })).status).toBe(400);
  });
});

describe("the list", () => {
  it("every account with its role, status and name; staff and admins first, then guests", async () => {
    cognito
      .on(ListUsersInGroupCommand, { GroupName: "admins" })
      .resolves({ Users: [{ Username: "u-admin" }] });
    cognito
      .on(ListUsersInGroupCommand, { GroupName: "guests" })
      .resolves({ Users: [{ Username: "u-guest" }] });
    const user = (
      username: string,
      sub: string,
      email: string,
      status: UserStatusType,
      enabled = true,
    ) => ({
      Username: username,
      Enabled: enabled,
      UserStatus: status,
      UserCreateDate: new Date(1_700_000_000_000),
      Attributes: [
        { Name: "sub", Value: sub },
        { Name: "email", Value: email },
      ],
    });
    cognito.on(ListUsersCommand).resolves({
      Users: [
        user("u-guest", "g-1", "client@acme.com", "CONFIRMED"),
        user("u-staff", STAFF.userId, STAFF.email, "FORCE_CHANGE_PASSWORD"),
        user("u-admin", ADMIN.userId, ADMIN.email, "CONFIRMED"),
        user("u-off", "o-1", "old@mt.ec", "CONFIRMED", false),
      ],
    });
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [
        { userId: ADMIN.userId, displayName: "Carlos" },
        { userId: STAFF.userId, displayName: "Ana" },
      ],
    });
    const { status, body } = await call("GET /admin/users");
    expect(status).toBe(200);
    expect((body.members as TeamMember[]).map((m) => [m.displayName, m.role, m.status])).toEqual([
      ["Ana", "member", "invited"],
      ["Carlos", "admin", "active"],
      ["old", "member", "disabled"],
      ["client", "guest", "active"],
    ]);
  });
});

describe("changing a role", () => {
  const found = (groups: string[]) => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "u-staff",
          Attributes: [
            { Name: "sub", Value: STAFF.userId },
            { Name: "email", Value: STAFF.email },
          ],
        },
      ],
    });
    cognito
      .on(AdminListGroupsForUserCommand)
      .resolves({ Groups: groups.map((GroupName) => ({ GroupName })) });
  };
  const put = (userId: string, role: string) =>
    call("PUT /admin/users/{userId}/role", { role }, ADMIN, "[admins]", { userId });

  it("staff → admin: added to the admins group, and users follows", async () => {
    found([]);
    const { status, body } = await put(STAFF.userId, "admin");
    expect(status).toBe(200);
    expect(body.member).toMatchObject({ userId: STAFF.userId, role: "admin" });
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input).toMatchObject({
      Username: "u-staff",
      GroupName: "admins",
    });
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { userId: STAFF.userId },
      ExpressionAttributeValues: expect.objectContaining({ ":role": "admin" }),
    });
  });

  it("admin → staff: out of the admins group; no profile yet is fine", async () => {
    found(["admins"]);
    cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "no row", $metadata: {} }));
    expect((await put(STAFF.userId, "member")).status).toBe(200);
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)).toHaveLength(1);
  });

  it("never your own role, never a guest's, never an unknown account", async () => {
    expect((await put(ADMIN.userId, "member")).status).toBe(409);
    found(["guests"]);
    expect((await put(STAFF.userId, "admin")).status).toBe(409);
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    expect((await put(STAFF.userId, "admin")).status).toBe(404);
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
  });
});
