import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { dmChannelId } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/messages";
import type { HttpEvent } from "../src/lib/http";
import { ALICE, BOB, ddbMock, GENERAL, mockChannels, resetMocks, sentEvents } from "./helpers";

const s3Mock = mockClient(S3Client);
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const MESSAGES = "slack-test-messages";
const NOW = 1_770_000_000_000;
const CH = GENERAL.channelId;

function request(
  channelId: string,
  sk: string,
  user: { userId: string; email: string; groups?: string[] } = ALICE,
): HttpEvent {
  return {
    version: "2.0",
    routeKey: "DELETE /messages/{channelId}/{sk}",
    rawPath: `/messages/${channelId}/${encodeURIComponent(sk)}`,
    pathParameters: { channelId, sk: encodeURIComponent(sk) },
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      http: { method: "DELETE", path: "/messages" },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(user.groups && { "cognito:groups": user.groups }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
}
const del = async (sk: string, user?: Parameters<typeof request>[2], channelId = CH) => {
  const result = (await handler(request(channelId, sk, user))) as {
    statusCode: number;
    body?: string;
  };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};

const message = (sk: string, patch: Record<string, unknown> = {}) => ({
  messageId: `m-${sk}`,
  channelId: CH,
  sk,
  userId: ALICE.userId,
  userEmail: ALICE.email,
  text: "secret plans",
  attachments: [],
  createdAt: 1,
  ...patch,
});
const stored = (item: Record<string, unknown>) =>
  ddbMock
    .on(GetCommand, { TableName: MESSAGES, Key: { channelId: item.channelId, sk: item.sk } })
    .resolves({ Item: item });
const events = () =>
  sentEvents()
    .filter(([id]) => id === "conn-bob")
    .map(([, e]) => e);

beforeEach(() => {
  resetMocks();
  s3Mock.reset();
  s3Mock.on(DeleteObjectsCommand).resolves({});
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  mockChannels(GENERAL);
  ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
    Items: [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-bob", userId: BOB.userId },
    ],
  });
});

describe("DELETE /messages/{channelId}/{sk}", () => {
  it("removes a message without replies outright, with its files, and tells everyone", async () => {
    stored(
      message("100#a", {
        attachments: [
          { key: "attachments/ch_general/1-a.png", thumbKey: "attachments/ch_general/1-a.t.webp" },
          { key: "attachments/ch_general/2-b.pdf" },
        ],
      }),
    );
    const { status } = await del("100#a");
    expect(status).toBe(204);
    const [write] = ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input);
    expect(write!.TransactItems).toEqual([
      {
        Delete: {
          TableName: MESSAGES,
          Key: { channelId: CH, sk: "100#a" },
          ConditionExpression:
            "messageId = :id AND (attribute_not_exists(replyCount) OR replyCount = :zero)",
          ExpressionAttributeValues: { ":id": "m-100#a", ":zero": 0 },
        },
      },
    ]);
    const keys = s3Mock.commandCalls(DeleteObjectsCommand)[0]!.args[0].input.Delete!.Objects;
    expect(keys!.map((o) => o.Key)).toEqual([
      "attachments/ch_general/1-a.png",
      "attachments/ch_general/1-a.t.webp",
      "attachments/ch_general/2-b.pdf",
    ]);
    expect(events()).toEqual([
      { type: "message.deleted", channelId: CH, sk: "100#a", messageId: "m-100#a" },
    ]);
  });

  it("keeps a message with replies as a tombstone so its thread stays", async () => {
    stored(message("100#a", { replyCount: 2, reactions: { "👍": new Set([BOB.userId]) } }));
    expect((await del("100#a")).status).toBe(204);
    const update =
      ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Update!;
    expect(update.UpdateExpression).toBe(
      "SET deletedAt = :now, #text = :empty, attachments = :none REMOVE reactions, replyTo, isEdited, editedAt, isSecret, expiresAt, kind, meeting, aiNotes, pinnedAt, pinnedBy",
    );
    expect(events()).toEqual([
      {
        type: "message.updated",
        channelId: CH,
        sk: "100#a",
        messageId: "m-100#a",
        text: "",
        deletedAt: NOW,
      },
    ]);
  });

  it("falls back to a tombstone when a reply lands between the read and the delete", async () => {
    stored(message("100#a"));
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(
        new TransactionCanceledException({
          message: "cancelled",
          $metadata: {},
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        }),
      )
      .resolves({});
    expect((await del("100#a")).status).toBe(204);
    expect(events()[0]).toMatchObject({ type: "message.updated", deletedAt: NOW });
  });

  it("deletes a reply and recounts its parent from the replies left", async () => {
    const parentSk = "100#p";
    stored(message(parentSk, { replyCount: 3, replyUserIds: [BOB.userId, ALICE.userId] }));
    const reply = message(`thread#${parentSk}#300#c`, {
      parentSk,
      parentId: "m-100#p",
      createdAt: 300,
    });
    stored(reply);
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).callsFake((input) =>
      input.KeyConditionExpression.includes("begins_with")
        ? {
            Items: [
              { sk: `thread#${parentSk}#200#b`, userId: BOB.userId, createdAt: 200 },
              { sk: `thread#${parentSk}#250#x`, userId: CAROL.userId, createdAt: 250 },
              { sk: reply.sk, userId: ALICE.userId, createdAt: 300 },
            ],
          }
        : { Items: [] },
    );
    expect((await del(reply.sk)).status).toBe(204);
    const [, parentUpdate] =
      ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(parentUpdate!.Update).toMatchObject({
      UpdateExpression: "SET replyCount = :count, lastReplyAt = :last, replyUserIds = :ids",
      ConditionExpression: "attribute_exists(sk) AND replyCount = :was",
      ExpressionAttributeValues: {
        ":count": 2,
        ":was": 3,
        ":last": 250,
        ":ids": [BOB.userId, CAROL.userId], // Alice's only reply is gone
      },
    });
    expect(events()).toEqual([
      {
        type: "message.deleted",
        channelId: CH,
        sk: reply.sk,
        messageId: reply.messageId,
        parentSk,
      },
      {
        type: "message.thread_updated",
        channelId: CH,
        sk: parentSk,
        messageId: "m-100#p",
        replyCount: 2,
        lastReplyAt: 250,
        replyUserIds: [BOB.userId, CAROL.userId],
      },
    ]);
  });

  it("removes a deleted parent together with its last reply", async () => {
    const parentSk = "100#p";
    stored(message(parentSk, { replyCount: 1, deletedAt: 5, text: "" }));
    const reply = message(`thread#${parentSk}#300#c`, { parentSk, createdAt: 300 });
    stored(reply);
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({
      Items: [{ sk: reply.sk, userId: ALICE.userId, createdAt: 300 }],
    });
    await del(reply.sk);
    const [, parentWrite] =
      ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(parentWrite!.Delete).toMatchObject({ Key: { channelId: CH, sk: parentSk } });
    expect(events().map((e) => [e.type, "sk" in e ? e.sk : ""])).toEqual([
      ["message.deleted", reply.sk],
      ["message.deleted", parentSk],
    ]);
  });

  it("clears the copied text from quotes of it, which say the original is gone", async () => {
    stored(message("100#a"));
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({
      Items: [
        {
          sk: "200#q",
          messageId: "m-q",
          text: "agreed",
          replyTo: {
            messageId: "m-100#a",
            sk: "100#a",
            userId: ALICE.userId,
            preview: "secret plans",
            hasAttachments: false,
          },
        },
      ],
    });
    await del("100#a");
    const query = ddbMock.commandCalls(QueryCommand, { TableName: MESSAGES })[0]!.args[0].input;
    expect(query).toMatchObject({
      KeyConditionExpression: "channelId = :c AND sk > :sk",
      FilterExpression: "replyTo.sk = :sk",
    });
    const quote = {
      messageId: "m-100#a",
      sk: "100#a",
      userId: ALICE.userId,
      preview: "",
      hasAttachments: false,
      deleted: true,
    };
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual(
      {
        ":quote": quote,
      },
    );
    expect(events()[1]).toEqual({
      type: "message.updated",
      channelId: CH,
      sk: "200#q",
      messageId: "m-q",
      text: "agreed",
      replyTo: quote,
    });
    expect(JSON.stringify(events())).not.toContain("secret plans");
  });

  it("drops an AI notes card's hub entries with it", async () => {
    const dm = dmChannelId(ALICE.userId, BOB.userId);
    mockChannels(GENERAL, {
      channelId: dm,
      name: dm,
      type: "dm",
      createdBy: ALICE.userId,
      createdAt: 1,
      archived: false,
      members: [ALICE.userId, BOB.userId],
    });
    stored(
      message("100#n", {
        channelId: dm,
        kind: "ai_notes",
        aiNotes: { participants: [ALICE.userId, BOB.userId] },
      }),
    );
    await del("100#n", ALICE, dm);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.slice(1)).toEqual(
      [ALICE.userId, BOB.userId].map((userId) => ({
        Delete: { TableName: "slack-test-meeting-notes", Key: { userId, sk: "100#n" } },
      })),
    );
  });

  it("lets an admin moderate others' messages; members only their own", async () => {
    stored(message("100#a"));
    const member = await del("100#a", BOB);
    expect(member.status).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const admin = await del("100#a", { ...BOB, groups: ["admins"] });
    expect(admin.status).toBe(204);
  });

  it("404 for a message that's gone (or already a tombstone), an unknown or hidden conversation; 409 when archived", async () => {
    expect((await del("999#x")).status).toBe(404);
    stored(message("100#t", { deletedAt: 1 }));
    expect((await del("100#t")).status).toBe(404);
    expect((await del("100#a", ALICE, "ch_secret")).status).toBe(404);
    mockChannels({ ...GENERAL, archived: true });
    stored(message("100#a"));
    expect((await del("100#a")).status).toBe(409);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("still succeeds when the files can't be removed (logged)", async () => {
    stored(message("100#a", { attachments: [{ key: "attachments/ch_general/1-a.png" }] }));
    s3Mock.on(DeleteObjectsCommand).rejects(new Error("SlowDown"));
    expect((await del("100#a")).status).toBe(204);
    expect(events()).toHaveLength(1);
  });
});

describe("file cleanup stays inside the conversation's folder", () => {
  beforeEach(() => {
    resetMocks();
    s3Mock.reset();
    s3Mock.on(DeleteObjectsCommand).resolves({});
    mockChannels(GENERAL);
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(ScanCommand).resolves({ Items: [] });
  });

  it("never deletes a key outside attachments/<channelId>/", async () => {
    stored(
      message("100#a", {
        attachments: [
          { key: "attachments/ch_general/1-a.png" },
          { key: "attachments/b_01HZZZZZZZZZZZZZZZZZZZZZZZ/task.pdf" },
          { key: "attachments/ch_general/../ch_secret/x.png" },
        ],
      }),
    );
    await del("100#a");
    const keys = s3Mock.commandCalls(DeleteObjectsCommand)[0]!.args[0].input.Delete!.Objects;
    expect(keys!.map((o) => o.Key)).toEqual(["attachments/ch_general/1-a.png"]);
  });
});
