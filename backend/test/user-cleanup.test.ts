import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler, RECONCILE } from "../src/handlers/user-cleanup";
import { deletedSub } from "../src/lib/orphans";
import { ddbMock, resetMocks } from "./helpers";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const POOL = "us-east-1_TEST";
const GONE = "11111111-2222-4333-8444-555555555555";
const KEPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HIDDEN = "HIDDEN_DUE_TO_SECURITY_REASONS";

/** An "AWS API Call via CloudTrail" event as EventBridge delivers it. */
const event = (detail: Record<string, unknown>) => ({
  "detail-type": "AWS API Call via CloudTrail",
  source: "aws.cognito-idp",
  detail: {
    eventSource: "cognito-idp.amazonaws.com",
    eventName: "AdminDeleteUser",
    requestParameters: { userPoolId: POOL, username: HIDDEN },
    ...detail,
  },
});

const deletedKeys = () =>
  ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.userId);

beforeEach(() => {
  resetMocks();
  cognitoMock.reset();
  ddbMock.on(DeleteCommand).resolves({});
  // By default the account is gone.
  cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
});

describe("deletedSub", () => {
  it("reads the sub CloudTrail puts in additionalEventData (the username is hidden)", () => {
    expect(
      deletedSub({ requestParameters: { username: HIDDEN }, additionalEventData: { sub: GONE } }),
    ).toBe(GONE);
  });

  it("falls back to an unhidden username when it is a sub, and never to anything else", () => {
    expect(deletedSub({ requestParameters: { username: GONE } })).toBe(GONE);
    expect(deletedSub({ requestParameters: { username: "ana@example.com" } })).toBeNull();
    expect(deletedSub({ requestParameters: { username: HIDDEN } })).toBeNull();
    expect(deletedSub({})).toBeNull();
  });
});

describe("user-cleanup", () => {
  it("deletes the deleted account's profile row once Cognito confirms it is gone", async () => {
    const result = await handler(event({ additionalEventData: { sub: GONE } }));

    expect(result).toEqual({ deleted: [GONE] });
    expect(deletedKeys()).toEqual([GONE]);
    expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input.TableName).toBe(
      "slack-test-users",
    );
    expect(cognitoMock.commandCalls(ListUsersCommand)[0]!.args[0].input).toMatchObject({
      UserPoolId: POOL,
      Filter: `sub = "${GONE}"`,
    });
  });

  it("deletes nothing when the account still exists", async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [{ Username: GONE }] });
    expect(await handler(event({ additionalEventData: { sub: GONE } }))).toEqual({ deleted: [] });
    expect(deletedKeys()).toEqual([]);
  });

  it("ignores failed calls and other pools' events", async () => {
    await handler(
      event({ additionalEventData: { sub: GONE }, errorCode: "UserNotFoundException" }),
    );
    await handler(
      event({
        additionalEventData: { sub: GONE },
        requestParameters: { userPoolId: "us-east-1_OTHER", username: HIDDEN },
      }),
    );
    expect(deletedKeys()).toEqual([]);
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
  });

  it("without a sub in the event, reconciles: deletes every profile with no account, never externals", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [{ userId: KEPT }, { userId: GONE }, { userId: "ext_guest1" }],
    });
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Attributes: [{ Name: "sub", Value: KEPT }] }],
    });

    const result = await handler(event({}));

    expect(result).toEqual({ deleted: [GONE] });
    expect(deletedKeys()).toEqual([GONE]);
  });

  it("the 15-minute schedule reconciles the whole table, no CloudTrail event needed", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [{ userId: KEPT }, { userId: GONE }, { userId: "ext_guest1" }],
    });
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Attributes: [{ Name: "sub", Value: KEPT }] }],
    });
    expect(RECONCILE).toEqual({ action: "reconcile" });
    expect(await handler(RECONCILE)).toEqual({ deleted: [GONE] });
    expect(deletedKeys()).toEqual([GONE]);
    // Nothing to do: nothing deleted.
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-users" })
      .resolves({ Items: [{ userId: KEPT }] });
    ddbMock.resetHistory();
    expect(await handler(RECONCILE)).toEqual({ deleted: [] });
    expect(deletedKeys()).toEqual([]);
  });

  it("refuses when not one profile has an account in the pool (a wrong pool id)", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [{ userId: KEPT }, { userId: GONE }],
    });
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Attributes: [{ Name: "sub", Value: "99999999-9999-4999-8999-999999999999" }] }],
    });
    await expect(handler(RECONCILE)).rejects.toThrow(/refusing/);
    expect(deletedKeys()).toEqual([]);
  });

  it("refuses to reconcile against a pool that lists no accounts, and fails so EventBridge retries", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [{ userId: KEPT }],
    });
    await expect(handler(event({}))).rejects.toThrow(/refusing/);
    expect(deletedKeys()).toEqual([]);
  });
});
