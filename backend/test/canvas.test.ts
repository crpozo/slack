import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MAX_CANVAS_BYTES } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/canvas";
import { sanitizeCanvas } from "../src/lib/canvas";
import type { HttpEvent } from "../src/lib/http";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
} from "./helpers";

const CAROL = { userId: "user-carol", email: "carol@example.com" };
const CANVASES = "slack-test-canvases";
const NOW = 1_760_000_000_000;

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

const get = (id: string, user?: { userId: string; email: string }) =>
  call("GET /channels/{id}/canvas", { params: { id }, user });
const put = (id: string, body: unknown, user?: { userId: string; email: string }) =>
  call("PUT /channels/{id}/canvas", { params: { id }, body, user });

describe("sanitizeCanvas", () => {
  it("keeps the editor's blocks and marks and drops everything else, text included", () => {
    const html =
      "<h2>Plan</h2><p>Ship <strong>v2</strong> <em>soon</em> <s>never</s> <code>x</code></p>" +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li></ul>' +
      '<blockquote><p>q</p></blockquote><pre><code class="language-ts">let a</code></pre><hr>';
    expect(sanitizeCanvas(html)).toBe(
      html.replace("<hr>", "<hr />").replace("checked>", "checked />"),
    );
    expect(sanitizeCanvas("<p>hi<script>alert(1)</script><img src=x onerror=alert(1)></p>")).toBe(
      "<p>hi</p>",
    );
    expect(
      sanitizeCanvas('<p onclick="x()" style="color:red">a</p><iframe src="x"></iframe>'),
    ).toBe("<p>a</p>");
    expect(sanitizeCanvas('<p><input type="text" value="x"><input type="checkbox"></p>')).toBe(
      '<p><input type="checkbox" /></p>',
    );
  });

  it("only links to http(s) and mail, always in a new tab without a referrer", () => {
    expect(sanitizeCanvas('<a href="https://x.y/z">x</a>')).toBe(
      '<a href="https://x.y/z" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitizeCanvas('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });
});

describe("channel canvas", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    mockChannels(GENERAL, privateRow("ch_private", ALICE.userId, [ALICE.userId, BOB.userId]), {
      ...privateRow("ch_old", ALICE.userId, [ALICE.userId]),
      archived: true,
    });
    ddbMock.on(GetCommand, { TableName: CANVASES }).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
        { connectionId: "conn-carol", userId: CAROL.userId },
      ],
    });
  });

  it("answers an empty canvas before the first save, and the row after", async () => {
    expect((await get(GENERAL.channelId)).body.canvas).toEqual({
      channelId: GENERAL.channelId,
      content: "",
      version: 0,
      updatedAt: 0,
      updatedBy: "",
    });
    ddbMock.on(GetCommand, { TableName: CANVASES, Key: { channelId: "ch_private" } }).resolves({
      Item: {
        channelId: "ch_private",
        content: "<p>hi</p>",
        version: 3,
        updatedAt: 5,
        updatedBy: BOB.userId,
      },
    });
    expect((await get("ch_private", BOB)).body.canvas).toMatchObject({
      content: "<p>hi</p>",
      version: 3,
    });
  });

  it("hides channels the caller can't read, and reads an archived one", async () => {
    expect((await get("ch_private", CAROL)).status).toBe(404);
    expect((await get("ch_nope")).status).toBe(404);
    expect((await get("ch_old")).status).toBe(200);
  });

  it("saves sanitized content with the next version and tells the members", async () => {
    const { status, body } = await put("ch_private", {
      content: "<p>Notes<script>x</script></p>",
      version: 0,
    });
    expect(status).toBe(200);
    expect(body.canvas).toEqual({
      channelId: "ch_private",
      content: "<p>Notes</p>",
      version: 1,
      updatedAt: NOW,
      updatedBy: ALICE.userId,
    });
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update).toMatchObject({
      TableName: CANVASES,
      Key: { channelId: "ch_private" },
      ConditionExpression: "attribute_not_exists(channelId)",
      ExpressionAttributeValues: { ":content": "<p>Notes</p>", ":next": 1, ":me": ALICE.userId },
    });
    expect(sentEvents().map(([id, e]) => [id, e.type])).toEqual([
      ["conn-alice", "canvas.updated"],
      ["conn-bob", "canvas.updated"],
    ]);
    expect(sentEvents()[0]?.[1]).toEqual({
      type: "canvas.updated",
      channelId: "ch_private",
      version: 1,
      updatedAt: NOW,
      updatedBy: ALICE.userId,
    });

    // A later save is conditioned on the version it was based on.
    await put("ch_private", { content: "<p>More</p>", version: 1 });
    const second = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(second.ConditionExpression).toBe("version = :was");
    expect(second.ExpressionAttributeValues).toMatchObject({ ":was": 1, ":next": 2 });
  });

  it("refuses a stale save with 409 and the current canvas, telling nobody", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "stale", $metadata: {} }));
    ddbMock.on(GetCommand, { TableName: CANVASES, Key: { channelId: "ch_private" } }).resolves({
      Item: {
        channelId: "ch_private",
        content: "<p>theirs</p>",
        version: 4,
        updatedAt: 9,
        updatedBy: BOB.userId,
      },
    });
    const { status, body } = await put("ch_private", { content: "<p>mine</p>", version: 3 });
    expect(status).toBe(409);
    expect(body.canvas).toMatchObject({ content: "<p>theirs</p>", version: 4 });
    expect(sentEvents()).toEqual([]);
  });

  it("refuses saves to an archived channel, from outsiders, and oversized or malformed ones", async () => {
    expect((await put("ch_old", { content: "<p>x</p>", version: 0 })).status).toBe(403);
    expect((await put("ch_private", { content: "<p>x</p>", version: 0 }, CAROL)).status).toBe(404);
    expect(
      (await put("ch_private", { content: "x".repeat(MAX_CANVAS_BYTES + 1), version: 0 })).status,
    ).toBe(400);
    expect((await put("ch_private", { content: "<p>x</p>" })).status).toBe(400);
    expect((await put("ch_private", { content: "<p>x</p>", version: -1 })).status).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
