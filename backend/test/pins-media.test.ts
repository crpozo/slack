import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  ChannelFilesPage,
  ChannelLinksPage,
  ChannelPins,
  ServerEvent,
} from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as editHandler } from "../src/handlers/edit";
import { handler as messageHandler } from "../src/handlers/message";
import { handler as messagesHandler } from "../src/handlers/messages";
import { handler as pinHandler } from "../src/handlers/pin";
import type { HttpEvent } from "../src/lib/http";
import { decodeCursor, encodeCursor } from "../src/lib/media";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

const MESSAGES = "slack-test-messages";
const MEDIA = "slack-test-channel-media";
const NOW = 1_770_000_000_000;
const SK = "1769999999000#01AAAAAAAAAAAAAAAAAAAAAAAA";
const message = (patch: Record<string, unknown> = {}) => ({
  messageId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
  channelId: "ch_general",
  sk: SK,
  userId: BOB.userId,
  userEmail: BOB.email,
  text: "the spec: https://docs.mindfultech.ec/spec",
  attachments: [],
  createdAt: 1_769_999_999_000,
  ...patch,
});
const stored = (item: Record<string, unknown> | undefined) =>
  ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({ Item: item });
const cancelled = (codes: string[]) =>
  new TransactionCanceledException({
    message: "cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
const toBob = () =>
  sentEvents()
    .filter(([id]) => id === "conn-bob")
    .map(([, e]) => e);
const errorsToAlice = () =>
  sentEvents()
    .filter(([id, e]) => id === "conn-alice" && e.type === "error")
    .map(([, e]) => e as Extract<ServerEvent, { type: "error" }>);

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  mockChannels({ ...GENERAL, pinCount: 2 }, privateRow("ch_team", BOB.userId, [BOB.userId]), {
    ...privateRow("ch_old", ALICE.userId, [ALICE.userId, BOB.userId]),
    archived: true,
  });
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({ Attributes: { pinCount: 1 } });
  ddbMock.on(BatchWriteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
    Items: [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-bob", userId: BOB.userId },
    ],
  });
});

const pin = (body: Record<string, unknown> = {}) =>
  pinHandler(
    wsEvent("pin", { action: "pin", channelId: "ch_general", sk: SK, pinned: true, ...body }),
  );

describe("pin", () => {
  it("pins in one transaction (message, index row, channel count) and tells the channel", async () => {
    stored(message());
    expect((await pin()).statusCode).toBe(200);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]?.Update).toMatchObject({
      TableName: MESSAGES,
      Key: { channelId: "ch_general", sk: SK },
      UpdateExpression: "SET pinnedAt = :at, pinnedBy = :by",
      ExpressionAttributeValues: { ":at": NOW, ":by": ALICE.userId },
    });
    expect(items[1]?.Put).toEqual({
      TableName: MEDIA,
      Item: {
        channelId: "ch_general",
        sk: `pin#${NOW}#01AAAAAAAAAAAAAAAAAAAAAAAA`,
        kind: "pin",
        messageId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
        messageSk: SK,
        pinnedAt: NOW,
        pinnedBy: ALICE.userId,
      },
    });
    expect(items[2]?.Update).toMatchObject({
      TableName: "slack-test-channels",
      UpdateExpression: "ADD pinCount :one",
      ExpressionAttributeValues: { ":one": 1, ":max": 100 },
    });
    expect(toBob()).toEqual([
      {
        type: "message.pinned",
        channelId: "ch_general",
        sk: SK,
        messageId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
        pinnedAt: NOW,
        pinnedBy: ALICE.userId,
        pinCount: 3,
      },
    ]);
  });

  it("unpins: removes the fields, the row and one from the count", async () => {
    stored(message({ pinnedAt: 5, pinnedBy: BOB.userId }));
    await pin({ pinned: false });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]?.Update?.UpdateExpression).toBe("REMOVE pinnedAt, pinnedBy");
    expect(items[1]?.Delete).toEqual({
      TableName: MEDIA,
      Key: { channelId: "ch_general", sk: "pin#0000000000005#01AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(items[2]?.Update?.ExpressionAttributeValues).toMatchObject({ ":minus": -1 });
    expect(toBob()[0]).toEqual({
      type: "message.pinned",
      channelId: "ch_general",
      sk: SK,
      messageId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      pinCount: 1,
    });
  });

  it("does nothing when it's already as asked", async () => {
    stored(message({ pinnedAt: 5, pinnedBy: BOB.userId }));
    await pin();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sentEvents()).toHaveLength(0);
  });

  it("refuses secrets, deleted messages, archived channels, strangers and the 101st pin", async () => {
    stored(message({ isSecret: true }));
    await pin();
    stored(message({ deletedAt: 1 }));
    await pin();
    stored(message());
    await pin({ channelId: "ch_old" });
    await pin({ channelId: "ch_team" });
    mockChannels({ ...GENERAL, pinCount: 100 });
    await pin();
    expect(errorsToAlice().map((e) => e.code)).toEqual([
      "FORBIDDEN",
      "MESSAGE_NOT_FOUND",
      "FORBIDDEN",
      "CHANNEL_NOT_FOUND",
      "FORBIDDEN",
    ]);
    expect(errorsToAlice()[4]?.message).toMatch(/up to 100 pinned messages/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("reports a race (the limit reached meanwhile, or the message changed)", async () => {
    stored(message());
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["None", "None", "ConditionalCheckFailed"]))
      .rejectsOnce(cancelled(["ConditionalCheckFailed", "None", "None"]));
    await pin();
    await pin();
    expect(errorsToAlice().map((e) => e.code)).toEqual(["FORBIDDEN", "MESSAGE_NOT_FOUND"]);
    expect(toBob()).toEqual([]);
  });
});

describe("the index follows messages", () => {
  const send = (body: Record<string, unknown>) =>
    messageHandler(
      wsEvent("message", { action: "message", channelId: "ch_general", clientId: "c1", ...body }),
    );

  it("a message without files or links is a plain put; one with them, a transaction with its rows", async () => {
    stored(undefined);
    await send({ text: "hola" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

    await send({ text: "see https://a.ec and `https://code.ec`", clientId: "c2" });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[1]?.Put).toMatchObject({
      TableName: MEDIA,
      Item: {
        kind: "link",
        url: "https://a.ec",
        domain: "a.ec",
        userId: ALICE.userId,
        createdAt: NOW,
      },
    });
  });

  it("secrets are never indexed", async () => {
    stored(undefined);
    await send({ text: "https://secret.ec/token", isSecret: true });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("an edit swaps the old links' rows for the new text's", async () => {
    ddbMock.on(UpdateCommand, { TableName: MESSAGES }).resolves({
      Attributes: message({ userId: ALICE.userId, text: "old https://old.ec" }),
    });
    await editHandler(
      wsEvent("edit", {
        action: "edit",
        channelId: "ch_general",
        sk: SK,
        text: "new https://new.ec",
      }),
    );
    const writes = ddbMock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems![MEDIA]);
    // Same position in the message, same key: the put replaces the old row.
    expect(writes).toEqual([
      [
        {
          PutRequest: {
            Item: expect.objectContaining({
              sk: "link#1769999999000#01AAAAAAAAAAAAAAAAAAAAAAAA#00",
              url: "https://new.ec",
              snippet: "new https://new.ec",
            }),
          },
        },
      ],
    ]);
  });

  it("an edit that drops a link deletes its row", async () => {
    ddbMock.on(UpdateCommand, { TableName: MESSAGES }).resolves({
      Attributes: message({ userId: ALICE.userId, text: "https://a.ec https://b.ec" }),
    });
    await editHandler(
      wsEvent("edit", {
        action: "edit",
        channelId: "ch_general",
        sk: SK,
        text: "https://a.ec only",
      }),
    );
    const [first] = ddbMock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems![MEDIA]);
    expect(first).toEqual([
      {
        DeleteRequest: {
          Key: { channelId: "ch_general", sk: "link#1769999999000#01AAAAAAAAAAAAAAAAAAAAAAAA#01" },
        },
      },
    ]);
  });
});

function get(
  route: "files" | "links" | "pins",
  channelId = "ch_general",
  user: { userId: string; email: string; groups?: string[] } = ALICE,
  cursor?: string,
): HttpEvent {
  return {
    version: "2.0",
    routeKey: `GET /channels/{channelId}/${route}`,
    rawPath: `/channels/${channelId}/${route}`,
    pathParameters: { channelId },
    ...(cursor && { queryStringParameters: { cursor } }),
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      http: { method: "GET", path: `/channels/${channelId}/${route}` },
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
const call = async (event: HttpEvent) => {
  const result = (await messagesHandler(event)) as { statusCode: number; body?: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};

describe("GET /channels/{channelId}/files|links|pins", () => {
  it("files: one page from the index, newest first, images signed; the cursor round-trips", async () => {
    const last = { channelId: "ch_general", sk: "file#1#M#00" };
    ddbMock.on(QueryCommand, { TableName: MEDIA }).resolves({
      Items: [
        {
          channelId: "ch_general",
          sk: "file#1769999999000#M1#00",
          kind: "file",
          messageId: "M1",
          messageSk: SK,
          userId: BOB.userId,
          createdAt: 1_769_999_999_000,
          attachment: {
            key: "attachments/ch_general/p.png",
            name: "p.png",
            contentType: "image/png",
            size: 5,
          },
        },
      ],
      LastEvaluatedKey: last,
    });
    const { status, body } = await call(get("files", "ch_general", ALICE, encodeCursor(last)!));
    expect(status).toBe(200);
    const page = body as ChannelFilesPage;
    expect(page.files[0]).toMatchObject({ messageId: "M1", messageSk: SK, userId: BOB.userId });
    expect(page.files[0]?.attachment.url).toMatch(/attachments\/ch_general\/p\.png\?/);
    expect(page.nextCursor).toBe(encodeCursor(last));
    const query = ddbMock.commandCalls(QueryCommand, { TableName: MEDIA })[0]!.args[0].input;
    expect(query).toMatchObject({
      KeyConditionExpression: "channelId = :c AND begins_with(sk, :k)",
      ExpressionAttributeValues: { ":c": "ch_general", ":k": "file#" },
      ScanIndexForward: false,
      Limit: 30,
      ExclusiveStartKey: last,
    });
  });

  it("a cursor from another conversation or kind is ignored", () => {
    const cursor = encodeCursor({ channelId: "ch_team", sk: "file#1" })!;
    expect(decodeCursor(cursor, "ch_general", "file")).toBeNull();
    expect(
      decodeCursor(encodeCursor({ channelId: "ch_general", sk: "link#1" })!, "ch_general", "file"),
    ).toBeNull();
    expect(decodeCursor("not-base64-json", "ch_general", "file")).toBeNull();
  });

  it("links", async () => {
    ddbMock.on(QueryCommand, { TableName: MEDIA }).resolves({
      Items: [
        {
          channelId: "ch_general",
          sk: "link#1#M1#00",
          kind: "link",
          messageId: "M1",
          messageSk: SK,
          userId: BOB.userId,
          createdAt: 1,
          url: "https://a.ec",
          domain: "a.ec",
          snippet: "see https://a.ec",
        },
      ],
    });
    const { body } = await call(get("links"));
    expect((body as ChannelLinksPage).links).toEqual([
      {
        channelId: "ch_general",
        messageId: "M1",
        messageSk: SK,
        userId: BOB.userId,
        createdAt: 1,
        url: "https://a.ec",
        domain: "a.ec",
        snippet: "see https://a.ec",
      },
    ]);
    expect((body as ChannelLinksPage).nextCursor).toBeNull();
  });

  it("pins: the messages as they are now, in pin order, minus deleted ones", async () => {
    ddbMock.on(QueryCommand, { TableName: MEDIA }).resolves({
      Items: [
        {
          channelId: "ch_general",
          sk: "pin#3#B",
          kind: "pin",
          messageId: "B",
          messageSk: "2#B",
          pinnedAt: 3,
          pinnedBy: ALICE.userId,
        },
        {
          channelId: "ch_general",
          sk: "pin#2#A",
          kind: "pin",
          messageId: "A",
          messageSk: "1#A",
          pinnedAt: 2,
          pinnedBy: ALICE.userId,
        },
        {
          channelId: "ch_general",
          sk: "pin#1#C",
          kind: "pin",
          messageId: "C",
          messageSk: "0#C",
          pinnedAt: 1,
          pinnedBy: ALICE.userId,
        },
      ],
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        [MESSAGES]: [
          message({ sk: "1#A", messageId: "A", text: "edited text", pinnedAt: 2 }),
          message({ sk: "2#B", messageId: "B", pinnedAt: 3 }),
          message({ sk: "0#C", messageId: "C", deletedAt: 9, pinnedAt: 1 }),
        ],
      },
    });
    const { status, body } = await call(get("pins"));
    expect(status).toBe(200);
    expect((body as ChannelPins).messages.map((m) => [m.messageId, m.text])).toEqual([
      ["B", "the spec: https://docs.mindfultech.ec/spec"],
      ["A", "edited text"],
    ]);
  });

  it("never guests, never conversations the caller can't see", async () => {
    expect((await call(get("files", "ch_general", { ...ALICE, groups: ["guests"] }))).status).toBe(
      403,
    );
    expect((await call(get("links", "ch_team"))).status).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand, { TableName: MEDIA })).toHaveLength(0);
  });
});

describe("deleting a message", () => {
  it("takes its files, links and pin out of the index, and lowers the count", async () => {
    stored(
      message({
        userId: ALICE.userId,
        attachments: [
          {
            key: "attachments/ch_general/a.pdf",
            name: "a.pdf",
            contentType: "application/pdf",
            size: 1,
          },
        ],
        pinnedAt: 7,
        pinnedBy: BOB.userId,
      }),
    );
    ddbMock.on(UpdateCommand, { TableName: "slack-test-channels" }).resolves({
      Attributes: { pinCount: 1 },
    });
    const event = {
      ...get("pins"),
      routeKey: "DELETE /messages/{channelId}/{sk}",
      pathParameters: { channelId: "ch_general", sk: encodeURIComponent(SK) },
    } as HttpEvent;
    expect((await call(event)).status).toBe(204);
    const keys = ddbMock
      .commandCalls(BatchWriteCommand)
      .flatMap((c) => c.args[0].input.RequestItems![MEDIA]!.map((r) => r.DeleteRequest?.Key?.sk));
    expect(keys).toEqual([
      "file#1769999999000#01AAAAAAAAAAAAAAAAAAAAAAAA#00",
      "link#1769999999000#01AAAAAAAAAAAAAAAAAAAAAAAA#00",
      "pin#0000000000007#01AAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
    expect(toBob()).toContainEqual({
      type: "message.pinned",
      channelId: "ch_general",
      sk: SK,
      messageId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      pinCount: 1,
    });
  });
});
