import {
  BatchGetCommand,
  BatchWriteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as search } from "../src/handlers/search";
import { handler as indexer } from "../src/handlers/search-indexer";
import type { HttpEvent } from "../src/lib/http";
import { indexChange } from "../src/lib/search";
import { ALICE, BOB, ddbMock, dmRow, GENERAL, privateRow, resetMocks } from "./helpers";

const SEARCH = "slack-test-message-search";
const MESSAGES = "slack-test-messages";
const T = 1_761_700_000_000;

const message = (sk: string, text: string, extra: Record<string, unknown> = {}) => ({
  channelId: "ch_general",
  sk,
  messageId: `m-${sk}`,
  userId: ALICE.userId,
  userEmail: ALICE.email,
  text,
  attachments: [],
  createdAt: Number(sk.split("#")[0]),
  ...extra,
});

describe("indexChange", () => {
  it("adds every term of a new message and removes every term of a deleted one", () => {
    const m = message(`${T}#A`, "The login bug is back");
    expect(indexChange(undefined, m)).toEqual({
      channelId: "ch_general",
      sk: `${T}#A`,
      add: ["login", "bug", "back"],
      remove: [],
    });
    expect(indexChange(m, undefined)?.remove).toEqual(["login", "bug", "back"]);
  });

  it("an edit writes only what changed; a reaction changes nothing", () => {
    const before = message(`${T}#A`, "The login bug is back");
    const after = { ...before, text: "The signup bug is back" };
    expect(indexChange(before, after)).toMatchObject({ add: ["signup"], remove: ["login"] });
    const reacted = { ...before, reactions: { "👍": [BOB.userId] } };
    expect(indexChange(before, reacted)).toBeNull();
  });

  it("never indexes a secret, and a tombstone loses its terms", () => {
    expect(indexChange(undefined, message(`${T}#S`, "hunter22", { isSecret: true }))).toBeNull();
    const m = message(`${T}#A`, "Quarterly numbers");
    expect(indexChange(m, { ...m, text: "", deletedAt: T + 1 })?.remove).toEqual([
      "quarterly",
      "numbers",
    ]);
  });
});

describe("the stream indexer", () => {
  beforeEach(() => {
    resetMocks();
    ddbMock.on(BatchWriteCommand).resolves({});
  });

  const record = (eventName: "INSERT" | "MODIFY" | "REMOVE", oldRow?: object, newRow?: object) => ({
    eventName,
    dynamodb: {
      ...(oldRow && { OldImage: marshall(oldRow, { removeUndefinedValues: true }) }),
      ...(newRow && { NewImage: marshall(newRow, { removeUndefinedValues: true }) }),
    },
  });

  it("writes the new terms and deletes the lost ones, 25 rows a batch, retrying the throttled", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const throttled = {
      [SEARCH]: [{ PutRequest: { Item: { channelId: "ch_general", sk: `word0#${T}#A` } } }],
    };
    ddbMock.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: throttled }).resolves({});
    await indexer({
      Records: [record("INSERT", undefined, message(`${T}#A`, long))],
    } as unknown as DynamoDBStreamEvent);
    const calls = ddbMock
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems![SEARCH]!);
    expect(calls.map((rows) => rows.length)).toEqual([25, 1, 5]); // 25, the retried 1, then 5
    expect(calls[0]![0]).toEqual({
      PutRequest: { Item: { channelId: "ch_general", sk: `word0#${T}#A` } },
    });
  });

  it("deletes a removed message's rows and skips anything that isn't a message", async () => {
    await indexer({
      Records: [
        record("REMOVE", message(`${T}#A`, "release notes")),
        record(
          "MODIFY",
          { channelId: "ch_general", sk: "meta" },
          { channelId: "ch_general", sk: "meta" },
        ),
      ],
    } as unknown as DynamoDBStreamEvent);
    const rows = ddbMock.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems![SEARCH]!;
    expect(rows).toEqual([
      { DeleteRequest: { Key: { channelId: "ch_general", sk: `release#${T}#A` } } },
      { DeleteRequest: { Key: { channelId: "ch_general", sk: `notes#${T}#A` } } },
    ]);
  });
});

describe("GET /search", () => {
  const event = (
    q: string | undefined,
    opts: { channelId?: string; user?: typeof ALICE; groups?: string } = {},
  ) =>
    ({
      version: "2.0",
      routeKey: "GET /search",
      rawPath: "/search",
      queryStringParameters: {
        ...(q !== undefined && { q }),
        ...(opts.channelId && { channelId: opts.channelId }),
      },
      headers: {},
      isBase64Encoded: false,
      requestContext: {
        http: { method: "GET", path: "/search" },
        authorizer: {
          jwt: {
            claims: {
              sub: (opts.user ?? ALICE).userId,
              email: (opts.user ?? ALICE).email,
              ...(opts.groups && { "cognito:groups": opts.groups }),
            },
            scopes: [],
          },
        },
      },
    }) as unknown as HttpEvent;
  const call = async (e: HttpEvent) => {
    const r = (await search(e)) as { statusCode: number; body?: string };
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
  };

  const dm = dmRow(ALICE.userId, BOB.userId);
  const secretRoom = privateRow("ch_secret", BOB.userId, [BOB.userId]); // Alice isn't in it
  const stored = [
    message(`${T + 3000}#C`, "Logins are failing again on Android"),
    message(`${T + 2000}#B`, "Fixed the login bug, deploying now"),
    message(`${T + 1000}#A`, "Lunch?"), // matches "login"'s index row? no: never indexed
    {
      ...message(`thread#${T}#P#${T + 4000}#R`, "Login bug on iOS too", {
        parentSk: `${T}#P`,
        createdAt: T + 4000,
      }),
      channelId: dm.channelId,
    },
  ];

  beforeEach(() => {
    resetMocks();
    ddbMock.on(ScanCommand).resolves({ Items: [GENERAL, dm, secretRoom] });
    ddbMock
      .on(QueryCommand)
      .callsFake((input: { ExpressionAttributeValues: Record<string, string> }) => {
        const channelId = input.ExpressionAttributeValues[":c"];
        const rows: Record<string, string[]> = {
          ch_general: [`logins#${T + 3000}#C`, `login#${T + 2000}#B`],
          [dm.channelId]: [`login#thread#${T}#P#${T + 4000}#R`],
        };
        return { Items: (rows[channelId!] ?? []).map((sk) => ({ sk })) };
      });
    ddbMock
      .on(BatchGetCommand)
      .callsFake(
        (input: {
          RequestItems: Record<string, { Keys: Array<{ channelId: string; sk: string }> }>;
        }) => ({
          Responses: {
            [MESSAGES]: input.RequestItems[MESSAGES]!.Keys.map((k) =>
              stored.find((m) => m.channelId === k.channelId && m.sk === k.sk),
            ).filter(Boolean),
          },
        }),
      );
  });

  it("finds messages containing every term, newest first, only in conversations the caller sees", async () => {
    const { status, body } = await call(event("login bug"));
    expect(status).toBe(200);
    expect(body.terms).toEqual(["login", "bug"]);
    // "Logins are failing again" matches "login" but not "bug".
    expect(body.results.map((r: { sk: string }) => r.sk)).toEqual([
      `thread#${T}#P#${T + 4000}#R`,
      `${T + 2000}#B`,
    ]);
    expect(body.results[0]).toMatchObject({
      channelId: dm.channelId,
      parentSk: `${T}#P`,
      userId: ALICE.userId,
      createdAt: T + 4000,
      snippet: {
        text: "Login bug on iOS too",
        highlights: [
          [0, 5],
          [6, 9],
        ],
      },
    });
    // One prefix query per visible conversation, on the longest term; never the private one.
    const queries = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries.map((q) => q.ExpressionAttributeValues![":c"]).sort()).toEqual(
      ["ch_general", dm.channelId].sort(),
    );
    expect(queries[0]).toMatchObject({
      TableName: SEARCH,
      KeyConditionExpression: "channelId = :c AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":p": "login" },
      ScanIndexForward: false,
    });
  });

  it("a prefix finds whole words as you type", async () => {
    const { body } = await call(event("logi"));
    expect(body.results).toHaveLength(3);
    expect(body.results[1].snippet.text).toBe("Logins are failing again on Android");
  });

  it("can be limited to one conversation, which must be one the caller sees", async () => {
    const { body } = await call(event("login", { channelId: "ch_general" }));
    expect(body.results.map((r: { channelId: string }) => r.channelId)).toEqual([
      "ch_general",
      "ch_general",
    ]);
    expect((await call(event("login", { channelId: "ch_secret" }))).status).toBe(404);
  });

  it("answers no results for only short or common words, refuses a missing or long query and guests", async () => {
    expect((await call(event("a de la"))).body).toEqual({
      results: [],
      terms: [],
      truncated: false,
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect((await call(event(undefined))).status).toBe(400);
    expect((await call(event("x".repeat(101)))).status).toBe(400);
    expect((await call(event("login", { groups: "[guests]" }))).status).toBe(403);
  });

  it("skips a message deleted since it was indexed", async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [MESSAGES]: [] } });
    expect((await call(event("login"))).body.results).toEqual([]);
  });
});
