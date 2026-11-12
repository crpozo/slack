import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupOrphans } from "../scripts/backfill/orphans";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });
const ddbMock = mockClient(ddb);
const cognitoMock = mockClient(cognito);
const opts = { table: "slack-dev-users", userPoolId: "us-east-1_POOL" };
const account = (sub: string) => ({ Attributes: [{ Name: "sub", Value: sub }] });

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(ScanCommand).resolves({
    Items: [
      { userId: "a", email: "a@x.ec", displayName: "Ana" },
      { userId: "b", email: "b@x.ec", displayName: "Beto" },
      { userId: "c", email: "c@x.ec", displayName: "Cris" },
      { userId: "ext_1", displayName: "Guest" },
    ],
  });
  cognitoMock.on(ListUsersCommand).resolves({ Users: [account("a"), account("b")] });
});

const deleted = () => ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.userId);

describe("cleanup-orphans", () => {
  it("dry run: lists profiles without an account (never externals) and deletes nothing", async () => {
    const report = await cleanupOrphans(ddb, cognito, { ...opts, apply: false });
    expect(report).toEqual({
      profiles: 3,
      accounts: 2,
      orphans: [{ userId: "c", email: "c@x.ec", displayName: "Cris" }],
      deleted: 0,
    });
    expect(deleted()).toEqual([]);
  });

  it("--apply deletes exactly the orphans", async () => {
    const report = await cleanupOrphans(ddb, cognito, { ...opts, apply: true });
    expect(report.deleted).toBe(1);
    expect(deleted()).toEqual(["c"]);
  });

  it("refuses an empty pool listing, and a cleanup of over half the directory without --force", async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
    await expect(cleanupOrphans(ddb, cognito, { ...opts, apply: true })).rejects.toThrow(
      /lists no accounts/,
    );
    cognitoMock.on(ListUsersCommand).resolves({ Users: [account("a")] });
    await expect(cleanupOrphans(ddb, cognito, { ...opts, apply: true })).rejects.toThrow(/--force/);
    expect(deleted()).toEqual([]);
    const forced = await cleanupOrphans(ddb, cognito, { ...opts, apply: true, force: true });
    expect(forced.deleted).toBe(2);
  });
});
