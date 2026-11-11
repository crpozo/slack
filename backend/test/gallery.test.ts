import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  IMAGE_INDEX,
  imageAtFor,
  imageAtOf,
  MEDIA_WINDOW,
  type ChannelMediaWindow,
} from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as messageHandler } from "../src/handlers/message";
import { handler as messagesHandler } from "../src/handlers/messages";
import { imagesOf, mediaWindow } from "../src/lib/gallery";
import type { HttpEvent } from "../src/lib/http";
import { storedMessage, toWireMessage } from "../src/lib/messages";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  wsEvent,
} from "./helpers";

const MESSAGES = "slack-test-messages";
const NOW = 1_770_000_000_000;

const png = (name: string) => ({
  key: `attachments/ch_general/${name}`,
  name,
  contentType: "image/png",
  size: 5,
});
const pdf = {
  key: "attachments/ch_general/spec.pdf",
  name: "spec.pdf",
  contentType: "application/pdf",
  size: 9,
};

/** A message as stored: `imageAt` only when it has an image (what `storedMessage` writes). */
function row(
  i: number,
  attachments: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const createdAt = 1_700_000_000_000 + i * 1000;
  const messageId = `M${String(i).padStart(3, "0")}`;
  const base = {
    channelId: "ch_general",
    sk: `${createdAt}#${messageId}`,
    messageId,
    userId: BOB.userId,
    createdAt,
    text: "",
    attachments,
    ...extra,
  };
  const imageAt = imageAtOf(base as never);
  return imageAt ? { ...base, imageAt } : base;
}

// --- The sparse GSI, mocked: only rows that have `imageAt` exist in it ------------------

let table: Array<Record<string, unknown>>;

/** A Query of `byImage`, as DynamoDB answers it: key condition, order, Limit, LastEvaluatedKey. */
function fakeImageIndex() {
  ddbMock.on(QueryCommand, { TableName: MESSAGES, IndexName: IMAGE_INDEX }).callsFake((input) => {
    const values = input.ExpressionAttributeValues ?? {};
    const at = String(values[":at"]);
    const older = /imageAt < :at/.test(input.KeyConditionExpression ?? "");
    const inIndex = table.filter(
      (r) => typeof r.imageAt === "string" && r.channelId === values[":c"],
    );
    const matching = inIndex
      .filter((r) => (older ? String(r.imageAt) < at : String(r.imageAt) >= at))
      .sort((a, b) => String(a.imageAt).localeCompare(String(b.imageAt)));
    if (input.ScanIndexForward === false) matching.reverse();
    const page = matching.slice(0, input.Limit);
    // The index projects its keys and the INCLUDE attributes only.
    const Items = page.map(
      ({ channelId, sk, imageAt, messageId, userId, createdAt, attachments }) => ({
        channelId,
        sk,
        imageAt,
        messageId,
        userId,
        createdAt,
        attachments,
      }),
    );
    const last = page.at(-1);
    return {
      Items,
      ...(matching.length > page.length &&
        last && {
          LastEvaluatedKey: { channelId: last.channelId, sk: last.sk, imageAt: last.imageAt },
        }),
    };
  });
}

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  mockChannels(GENERAL, privateRow("ch_team", BOB.userId, [BOB.userId]));
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({ Items: [] });
  table = [];
  fakeImageIndex();
});

describe("the sparse index key", () => {
  it("only messages with an image get imageAt, ordered by time across replies too", () => {
    expect(imageAtOf(row(1, [png("a.png")]) as never)).toBe(imageAtFor(1_700_000_001_000, "M001"));
    expect(imageAtFor(5, "X")).toBe("0000000000005#X");
    expect(imageAtOf(row(2, [pdf]) as never)).toBeUndefined();
    expect(imageAtOf(row(3, []) as never)).toBeUndefined();
    expect(imageAtOf({ ...row(4, [png("s.png")]), isSecret: true } as never)).toBeUndefined();
    expect(imageAtOf({ ...row(5, [png("d.png")]), deletedAt: 1 } as never)).toBeUndefined();
    // A reply's table key sorts after every top-level message; its imageAt doesn't.
    const reply = row(6, [png("r.png")], { sk: "thread#1700000001000#M001#1700000006000#M006" });
    expect(String(reply.imageAt) > String(row(1, [png("a.png")]).imageAt)).toBe(true);
    expect(String(reply.imageAt) < String(row(7, [png("b.png")]).imageAt)).toBe(true);
  });

  it("is written with image messages, never with others, and never sent to clients", () => {
    const withImage = storedMessage(row(1, [png("a.png"), pdf]) as never);
    expect(withImage.imageAt).toBe("1700000001000#M001");
    expect("imageAt" in storedMessage(row(2, [pdf]) as never)).toBe(false);
    expect("imageAt" in toWireMessage(withImage)).toBe(false);
  });

  it("sending: the stored item carries imageAt for an image, nothing for text", async () => {
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({});
    const send = (body: Record<string, unknown>) =>
      messageHandler(
        wsEvent("message", { action: "message", channelId: "ch_general", clientId: "c1", ...body }),
      );
    await send({ text: "hola" });
    const plain = ddbMock.commandCalls(PutCommand, { TableName: MESSAGES })[0]!.args[0].input.Item!;
    expect(plain.imageAt).toBeUndefined();

    await send({ text: "", clientId: "c2", attachments: [png("p.png")] });
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const item = tx[0]!.Put!.Item!;
    expect(item).toMatchObject({ imageAt: imageAtFor(NOW, String(item.messageId)) });
  });

  it("a deleted message that keeps its thread leaves the index (REMOVE imageAt)", async () => {
    const parent: Record<string, unknown> = {
      ...row(1, [png("a.png")]),
      userId: ALICE.userId,
      replyCount: 2,
    };
    ddbMock.on(GetCommand, { TableName: MESSAGES }).resolves({ Item: parent });
    ddbMock.on(UpdateCommand).resolves({});
    const event = {
      version: "2.0",
      routeKey: "DELETE /messages/{channelId}/{sk}",
      pathParameters: { channelId: "ch_general", sk: encodeURIComponent(String(parent.sk)) },
      headers: {},
      requestContext: {
        authorizer: { jwt: { claims: { sub: ALICE.userId, email: ALICE.email }, scopes: [] } },
      },
    } as unknown as HttpEvent;
    const result = (await messagesHandler(event)) as { statusCode: number };
    expect(result.statusCode).toBe(204);
    const update = ddbMock
      .commandCalls(TransactWriteCommand)
      .flatMap((c) => c.args[0].input.TransactItems!)
      .find((t) => t.Update?.Key?.sk === parent.sk)!.Update!;
    expect(update.UpdateExpression).toMatch(/REMOVE .*\bimageAt\b/);
  });
});

describe("the sliding window", () => {
  /** 50 messages: one image each, and #20 with three. */
  function history() {
    table = Array.from({ length: 50 }, (_, i) =>
      i === 20
        ? row(i, [png(`m20-a.png`), pdf, png(`m20-b.png`), png(`m20-c.png`)])
        : row(i, [png(`m${i}.png`)]),
    );
    // Text and files only: not in the index at all.
    table.push(row(100, [pdf]), row(101, []));
  }

  it("reads only the sparse index: 15 before, the image, 15 after", async () => {
    history();
    const around = String(table[30]!.imageAt);
    const win = await mediaWindow("ch_general", around, "attachments/ch_general/m30.png");
    expect(win.images).toHaveLength(2 * MEDIA_WINDOW + 1);
    expect(win.index).toBe(MEDIA_WINDOW);
    expect(win.images[win.index]!.attachment.name).toBe("m30.png");
    // Oldest first; message 20's three images sit in its place, in order.
    const names = win.images.map((i) => i.attachment.name);
    expect(names.slice(0, 5)).toEqual(["m17.png", "m18.png", "m19.png", "m20-a.png", "m20-b.png"]);
    expect(names).not.toContain("spec.pdf");
    expect(win).toMatchObject({ hasOlder: true, hasNewer: true });

    const queries = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q).toMatchObject({ TableName: MESSAGES, IndexName: IMAGE_INDEX });
      expect(q.Limit).toBeLessThanOrEqual(MEDIA_WINDOW + 1);
    }
    expect(queries.map((q) => [q.KeyConditionExpression, q.ScanIndexForward])).toEqual([
      ["channelId = :c AND imageAt < :at", false],
      ["channelId = :c AND imageAt >= :at", true],
    ]);
  });

  it("opens on the right image of a message with several", async () => {
    history();
    const around = String(table[20]!.imageAt);
    const win = await mediaWindow("ch_general", around, "attachments/ch_general/m20-b.png");
    expect(win.images[win.index]!.attachment.name).toBe("m20-b.png");
    expect(win.images[win.index]!.position).toBe(2);
    expect(win.images[win.index - 1]!.attachment.name).toBe("m20-a.png");
    expect(win.images[win.index + 1]!.attachment.name).toBe("m20-c.png");
    expect(win.images).toHaveLength(31);
  });

  it("near the start: what there is before, and no more", async () => {
    history();
    const win = await mediaWindow(
      "ch_general",
      String(table[2]!.imageAt),
      "attachments/ch_general/m2.png",
    );
    expect(win.index).toBe(2);
    expect(win).toMatchObject({ hasOlder: false, hasNewer: true });
  });

  it("an image deleted since: the images around that moment, index -1", async () => {
    history();
    const win = await mediaWindow("ch_general", imageAtFor(1_700_000_010_500, "GONE"), "x");
    expect(win.index).toBe(-1);
    expect(win.images.length).toBeGreaterThan(0);
    expect(win.images.length).toBeLessThanOrEqual(2 * MEDIA_WINDOW);
  });

  it("skips malformed rows", () => {
    expect(imagesOf({ channelId: "c" })).toEqual([]);
    expect(imagesOf({ ...row(1, [png("a.png")]), attachments: "nope" })).toEqual([]);
  });
});

describe("GET /channels/{channelId}/media", () => {
  const get = (
    channelId: string,
    query: Record<string, string>,
    user: { userId: string; email: string; groups?: string[] } = ALICE,
  ) =>
    ({
      version: "2.0",
      routeKey: "GET /channels/{channelId}/media",
      pathParameters: { channelId },
      queryStringParameters: query,
      headers: {},
      requestContext: {
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
    }) as unknown as HttpEvent;
  const call = async (event: HttpEvent) => {
    const r = (await messagesHandler(event)) as { statusCode: number; body?: string };
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
  };

  it("answers the window with signed URLs", async () => {
    table = [row(1, [png("a.png")]), row(2, [png("b.png")]), row(3, [png("c.png")])];
    const { status, body } = await call(
      get("ch_general", { around: String(table[1]!.imageAt), key: "attachments/ch_general/b.png" }),
    );
    expect(status).toBe(200);
    const win = body as ChannelMediaWindow;
    expect(win.images.map((i) => i.attachment.name)).toEqual(["a.png", "b.png", "c.png"]);
    expect(win.index).toBe(1);
    expect(win.images[1]!.attachment.url).toMatch(/attachments\/ch_general\/b\.png\?/);
  });

  it("refuses a malformed position, and conversations the caller can't read", async () => {
    expect((await call(get("ch_general", { around: "nope" }))).status).toBe(400);
    expect((await call(get("ch_general", {}))).status).toBe(400);
    const around = imageAtFor(1, "M");
    expect((await call(get("ch_team", { around }))).status).toBe(404);
    expect(
      (await call(get("ch_general", { around }, { ...ALICE, groups: ["guests"] }))).status,
    ).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand, { IndexName: IMAGE_INDEX })).toHaveLength(0);
  });
});
