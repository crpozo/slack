import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dmChannelId } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRemapper } from "../scripts/migrate/remap";
import { migrate, type Clients } from "../scripts/migrate/run";

// Dev subs, and the subs the prod pool hands out.
const ANA = "aaaaaaaa-1111-4111-8111-111111111111";
const BOB = "bbbbbbbb-2222-4222-8222-222222222222";
const ANA2 = "cccccccc-3333-4333-8333-333333333333";
const BOB2 = "dddddddd-4444-4444-8444-444444444444";
const map = new Map([
  [ANA, ANA2],
  [BOB, BOB2],
]);
const DM = dmChannelId(ANA, BOB);
const DM2 = dmChannelId(ANA2, BOB2);
const BOARD = "b_01JA0000000000000000000000";

describe("createRemapper", () => {
  const remap = createRemapper(map);

  it("rewrites ids, DM ids, membership keys and DM attachment keys", () => {
    expect(remap.string(ANA)).toBe(ANA2);
    expect(remap.string(`MEMBER#${BOB}`)).toBe(`MEMBER#${BOB2}`);
    expect(remap.string(DM)).toBe(DM2); // re-sorted for the new ids
    expect(remap.string(`attachments/${DM}/01J-photo.png`)).toBe(
      `attachments/${DM2}/01J-photo.png`,
    );
  });

  it("leaves everything else alone, including free text that mentions an id", () => {
    for (const v of [
      "ch_general",
      `attachments/ch_general/x.png`,
      `attachments/${BOARD}/spec.pdf`,
      `see ${ANA} here`,
      "unknown-user",
      "dm_malformed",
    ]) {
      expect(remap.string(v)).toBe(v);
    }
  });

  it("walks items: arrays, nested maps and string sets, without mutating them", () => {
    const message = {
      channelId: DM,
      sk: "1700000000000#01J",
      userId: ANA,
      userEmail: "ana@mt.ec",
      text: "hola",
      attachments: [{ key: `attachments/${DM}/01J-a.png`, name: "a.png", size: 3 }],
      reactions: { "👍": new Set([ANA, BOB]), "🎉": new Set([BOB]) },
      createdAt: 1,
    };
    const out = remap.value(message);
    expect(out).toEqual({
      ...message,
      channelId: DM2,
      userId: ANA2,
      attachments: [{ key: `attachments/${DM2}/01J-a.png`, name: "a.png", size: 3 }],
      reactions: { "👍": new Set([ANA2, BOB2]), "🎉": new Set([BOB2]) },
    });
    expect(message.userId).toBe(ANA); // input untouched
  });
});

// --- migrate() against mocked AWS ------------------------------------------------

const cfn = mockClient(CloudFormationClient);
const cognito = mockClient(CognitoIdentityProviderClient);
const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const clients: Clients = {
  cfn: new CloudFormationClient({}),
  cognito: new CognitoIdentityProviderClient({}),
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  s3: new S3Client({}),
};

const devData: Record<string, Record<string, unknown>[]> = {
  "slack-dev-users": [
    { userId: ANA, email: "ana@mt.ec", displayName: "Ana" },
    { userId: BOB, email: "bob@mt.ec", displayName: "Bob" },
  ],
  "slack-dev-channels": [
    { channelId: "ch_general", name: "general", type: "public", createdBy: "system" },
    { channelId: DM, name: DM, type: "dm", createdBy: ANA, members: [ANA, BOB] },
  ],
  "slack-dev-messages": [
    {
      channelId: DM,
      sk: "1#a",
      userId: BOB,
      text: "hi",
      attachments: [{ key: `attachments/${DM}/f.png` }],
      reactions: { "👍": new Set([ANA]) },
    },
  ],
  "slack-dev-boards": [
    { boardId: BOARD, sk: "BOARD", ownerId: ANA, members: new Set([ANA, BOB]), name: "Launch" },
    { boardId: BOARD, sk: `MEMBER#${ANA}`, userId: ANA },
    { boardId: BOARD, sk: `MEMBER#${BOB}`, userId: BOB },
  ],
  "slack-dev-tasks": [{ taskId: "t_1", boardId: BOARD, createdBy: BOB, assigneeId: ANA }],
};

const user = (email: string, sub: string) => ({
  Attributes: [
    { Name: "email", Value: email },
    { Name: "sub", Value: sub },
  ],
});

/** Items written to `table`, across all BatchWrite calls. */
const written = (table: string) =>
  ddb
    .commandCalls(BatchWriteCommand)
    .flatMap(
      (c) =>
        (c.args[0].input.RequestItems?.[table] ?? []) as Array<{ PutRequest: { Item: unknown } }>,
    )
    .map((r) => r.PutRequest.Item);

function setup(prodUsers: ReturnType<typeof user>[] = []) {
  for (const m of [cfn, cognito, ddb, s3]) m.reset();
  for (const [stack, pool, bucket] of [
    ["SlackDev", "pool-dev", "bucket-dev"],
    ["SlackProd", "pool-prod", "bucket-prod"],
  ]) {
    cfn.on(DescribeStacksCommand, { StackName: stack }).resolves({
      Stacks: [
        {
          StackName: stack,
          CreationTime: new Date(),
          StackStatus: "UPDATE_COMPLETE",
          Outputs: [
            { OutputKey: "UserPoolId", OutputValue: pool },
            { OutputKey: "AttachmentsBucket", OutputValue: bucket },
          ],
        },
      ],
    });
  }
  cognito
    .on(ListUsersCommand, { UserPoolId: "pool-dev" })
    .resolves({ Users: [user("ana@mt.ec", ANA), user("Bob@MT.ec", BOB)] });
  cognito.on(ListUsersCommand, { UserPoolId: "pool-prod" }).resolves({ Users: prodUsers });
  cognito
    .on(AdminCreateUserCommand, { Username: "ana@mt.ec" })
    .resolves({ User: user("ana@mt.ec", ANA2) });
  cognito
    .on(AdminCreateUserCommand, { Username: "bob@mt.ec" })
    .resolves({ User: user("bob@mt.ec", BOB2) });
  cognito.on(AdminSetUserPasswordCommand).resolves({});
  for (const [table, items] of Object.entries(devData)) {
    ddb.on(ScanCommand, { TableName: table }).resolves({ Items: items });
  }
  ddb.on(BatchWriteCommand).resolves({});
  s3.on(ListObjectsV2Command).resolves({
    Contents: [
      { Key: `attachments/${DM}/f.png`, Size: 10 },
      { Key: `attachments/ch_general/g.png`, Size: 20 },
    ],
  });
  s3.on(HeadObjectCommand).rejects(new NotFound({ message: "nope", $metadata: {} }));
  s3.on(CopyObjectCommand).resolves({});
}

const options = (apply: boolean) => ({
  from: { stack: "SlackDev", stage: "dev" },
  to: { stack: "SlackProd", stage: "prod" },
  apply,
  passwordFor: vi.fn(async () => "a-good-password"),
  log: () => {},
});

describe("migrate", () => {
  beforeEach(() => setup());

  it("dry run: reads everything, reports, and writes nothing anywhere", async () => {
    const opts = options(false);
    const report = await migrate(clients, opts);

    expect(report.items).toEqual({ users: 2, channels: 2, messages: 1, boards: 3, tasks: 1 });
    expect(report.files).toEqual({ copied: 2, skipped: 0 });
    expect(report.users.every((u) => u.created)).toBe(true);
    expect(opts.passwordFor).not.toHaveBeenCalled();
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(0);
  });

  it("creates the accounts with a permanent password and rewrites every id", async () => {
    const opts = options(true);
    const report = await migrate(clients, opts);

    expect(report.users.map((u) => [u.email, u.newId])).toEqual([
      ["ana@mt.ec", ANA2],
      ["bob@mt.ec", BOB2],
    ]);
    expect(opts.passwordFor).toHaveBeenCalledTimes(2);
    expect(cognito.commandCalls(AdminSetUserPasswordCommand)[0]?.args[0].input).toMatchObject({
      UserPoolId: "pool-prod",
      Username: "ana@mt.ec",
      Permanent: true,
    });
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]?.args[0].input).toMatchObject({
      UserPoolId: "pool-prod",
      MessageAction: "SUPPRESS",
    });

    expect(written("slack-prod-users")).toEqual([
      { userId: ANA2, email: "ana@mt.ec", displayName: "Ana" },
      { userId: BOB2, email: "bob@mt.ec", displayName: "Bob" },
    ]);
    expect(written("slack-prod-channels")).toContainEqual({
      channelId: DM2,
      name: DM2,
      type: "dm",
      createdBy: ANA2,
      members: [ANA2, BOB2],
    });
    expect(written("slack-prod-messages")).toEqual([
      expect.objectContaining({
        channelId: DM2,
        userId: BOB2,
        attachments: [{ key: `attachments/${DM2}/f.png` }],
        reactions: { "👍": new Set([ANA2]) },
      }),
    ]);
    expect(written("slack-prod-boards")).toEqual([
      expect.objectContaining({ sk: "BOARD", ownerId: ANA2, members: new Set([ANA2, BOB2]) }),
      { boardId: BOARD, sk: `MEMBER#${ANA2}`, userId: ANA2 },
      { boardId: BOARD, sk: `MEMBER#${BOB2}`, userId: BOB2 },
    ]);
    expect(written("slack-prod-tasks")).toEqual([
      { taskId: "t_1", boardId: BOARD, createdBy: BOB2, assigneeId: ANA2 },
    ]);
    // Nothing is ever written to dev.
    expect(
      ddb
        .commandCalls(BatchWriteCommand)
        .every((c) =>
          Object.keys(c.args[0].input.RequestItems ?? {}).every((t) => t.startsWith("slack-prod-")),
        ),
    ).toBe(true);

    const copies = s3.commandCalls(CopyObjectCommand).map((c) => c.args[0].input);
    expect(copies).toEqual([
      {
        Bucket: "bucket-prod",
        Key: `attachments/${DM2}/f.png`,
        CopySource: `bucket-dev/attachments/${DM}/f.png`,
      },
      {
        Bucket: "bucket-prod",
        Key: "attachments/ch_general/g.png",
        CopySource: "bucket-dev/attachments/ch_general/g.png",
      },
    ]);
  });

  it("running it again reuses the accounts and skips files already copied", async () => {
    setup([user("ana@mt.ec", ANA2), user("bob@mt.ec", BOB2)]);
    s3.on(HeadObjectCommand).resolves({ ContentLength: 10 });
    const opts = options(true);
    const report = await migrate(clients, opts);

    expect(report.users.every((u) => !u.created)).toBe(true);
    expect(opts.passwordFor).not.toHaveBeenCalled();
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect(written("slack-prod-tasks")).toEqual([
      { taskId: "t_1", boardId: BOARD, createdBy: BOB2, assigneeId: ANA2 },
    ]);
    // Same size → skipped; the 20-byte file differs from the 10-byte head → copied again.
    expect(report.files).toEqual({ copied: 1, skipped: 1 });
  });

  it("retries writes DynamoDB leaves unprocessed", async () => {
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: { "slack-prod-users": [{ PutRequest: { Item: { userId: ANA2 } } }] },
      })
      .resolves({});
    await migrate(clients, options(true));
    expect(
      written("slack-prod-users").filter((i) => (i as { userId: string }).userId === ANA2),
    ).toHaveLength(2);
  });

  it("encodes special characters in the copy source key", async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "attachments/ch_general/01J-mi foto+ñ.png", Size: 1 }],
    });
    await migrate(clients, options(true));
    expect(s3.commandCalls(CopyObjectCommand)[0]?.args[0].input.CopySource).toBe(
      "bucket-dev/attachments/ch_general/01J-mi%20foto%2B%C3%B1.png",
    );
  });

  it("fails clearly when a stack isn't deployed", async () => {
    cfn.on(DescribeStacksCommand, { StackName: "SlackProd" }).resolves({ Stacks: [] });
    await expect(migrate(clients, options(false))).rejects.toThrow(/SlackProd has no UserPoolId/);
  });
});
