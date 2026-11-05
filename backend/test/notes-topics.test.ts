import {
  BatchGetCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  dmChannelId,
  meetingTopicKey,
  type AiNotes,
  type MeetingNoteIndexItem,
  type Message,
} from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler, NOTES_BY_TOPIC_INDEX } from "../src/handlers/call-notes";
import type { HttpEvent } from "../src/lib/http";
import { applyUpdate, evaluateCondition } from "./fakeExpressions";
import {
  ALICE,
  BOB,
  ddbMock,
  dmRow,
  GENERAL,
  mockChannels,
  resetMocks,
  sentEvents,
} from "./helpers";

// Phase 50: meeting topics. Filing a meeting writes its card, its
// note-details row and everyone's pointer together; "my notes in a topic"
// is one query on the `byTopic` index of the pointers.

const CAROL = { userId: "user-carol", email: "carol@example.com" };
const DM = dmChannelId(ALICE.userId, BOB.userId);
const MESSAGES = "slack-test-messages";
const POINTERS = "slack-test-meeting-notes";
const DETAILS = "slack-test-note-details";

type Row = Record<string, unknown>;
let messages: Map<string, Row>;
let pointers: Map<string, MeetingNoteIndexItem & Row>;
let details: Map<string, Row>;
const msgKey = (k: Row) => `${String(k.channelId)}|${String(k.sk)}`;
const ptrKey = (k: Row) => `${String(k.userId)}|${String(k.sk)}`;

/** A ready notes card between Alice and Bob, with both their pointers. */
function card(n: number, patch: Partial<AiNotes> = {}): Message {
  const sk = `${1_760_000_000_000 + n * 60_000}#01CARD${String(n).padStart(20, "0")}`;
  const aiNotes: AiNotes = {
    callId: `01CALL${String(n).padStart(20, "0")}`,
    status: "ready",
    summary: `Meeting ${n}`,
    startedAt: 1,
    endedAt: 2,
    participants: [ALICE.userId, BOB.userId],
    ...patch,
  };
  const message: Message = {
    messageId: `m${n}`,
    channelId: DM,
    sk,
    userId: ALICE.userId,
    userEmail: ALICE.email,
    text: `✨ ${n}`,
    attachments: [],
    createdAt: 1,
    kind: "ai_notes",
    aiNotes,
  };
  messages.set(msgKey(message as unknown as Row), structuredClone(message) as unknown as Row);
  for (const userId of aiNotes.participants) {
    pointers.set(ptrKey({ userId, sk }), {
      userId,
      sk,
      channelId: DM,
      callId: aiNotes.callId,
      endedAt: 2,
    });
  }
  return message;
}

function fakeTables() {
  messages = new Map();
  pointers = new Map();
  details = new Map();
  ddbMock
    .on(BatchGetCommand)
    .callsFake(({ RequestItems }: { RequestItems: Record<string, { Keys: Row[] }> }) => {
      const Responses: Record<string, Row[]> = {};
      if (RequestItems[MESSAGES]) {
        Responses[MESSAGES] = RequestItems[MESSAGES].Keys.flatMap((k) => {
          const row = messages.get(msgKey(k));
          return row ? [structuredClone(row)] : [];
        });
      }
      if (RequestItems[POINTERS]) {
        Responses[POINTERS] = RequestItems[POINTERS].Keys.flatMap((k) => {
          const row = pointers.get(ptrKey(k));
          return row ? [{ ...row }] : [];
        });
      }
      return { Responses, UnprocessedKeys: {} };
    });
  ddbMock
    .on(QueryCommand, { TableName: POINTERS })
    .callsFake(
      (input: {
        IndexName?: string;
        ExpressionAttributeValues: Record<string, string>;
        FilterExpression?: string;
        Limit?: number;
        ExclusiveStartKey?: Row;
      }) => {
        const v = input.ExpressionAttributeValues;
        let rows = [...pointers.values()].filter((p) =>
          input.IndexName === NOTES_BY_TOPIC_INDEX ? p.topicKey === v[":k"] : p.userId === v[":me"],
        );
        if (input.FilterExpression) rows = rows.filter((p) => p.topic !== undefined);
        rows.sort((a, b) => (a.sk < b.sk ? 1 : -1));
        const after = input.ExclusiveStartKey?.sk;
        if (after) rows = rows.filter((p) => p.sk < String(after));
        const page = input.Limit ? rows.slice(0, input.Limit) : rows;
        const more = input.Limit !== undefined && rows.length > input.Limit;
        return {
          Items: page.map((p) => ({ ...p })),
          ...(more && {
            LastEvaluatedKey: {
              userId: page.at(-1)!.userId,
              sk: page.at(-1)!.sk,
              ...(input.IndexName && { topicKey: page.at(-1)!.topicKey }),
            },
          }),
        };
      },
    );
  ddbMock.on(TransactWriteCommand).callsFake(({ TransactItems }: { TransactItems: Row[] }) => {
    // All or nothing: check every condition, then apply.
    const apply: Array<() => void> = [];
    for (const op of TransactItems as Array<Record<string, Row>>) {
      const [kind, item] = Object.entries(op)[0]!;
      const table = String(item.TableName);
      if (kind === "Update" && table === MESSAGES) {
        const key = msgKey(item.Key as Row);
        const row = messages.get(key);
        const v = item.ExpressionAttributeValues as Row;
        const notes = row?.aiNotes as AiNotes | undefined;
        if (row?.kind !== v[":kind"] || notes?.callId !== v[":callId"]) {
          throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
        }
        apply.push(() => {
          const next = { ...notes };
          if (v[":topic"]) next.topic = String(v[":topic"]);
          else delete next.topic;
          messages.set(key, { ...row, aiNotes: next });
        });
      } else if (kind === "Update" && table === POINTERS) {
        const key = ptrKey(item.Key as Row);
        const row = pointers.get(key);
        if (!evaluateCondition(String(item.ConditionExpression), row)) {
          throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
        }
        apply.push(() =>
          pointers.set(
            key,
            applyUpdate(
              row!,
              String(item.UpdateExpression),
              item.ExpressionAttributeValues as Row,
            ) as MeetingNoteIndexItem & Row,
          ),
        );
      } else if (kind === "Put" && table === DETAILS) {
        const row = item.Item as Row;
        apply.push(() => details.set(`${String(row.callId)}|${String(row.sk)}`, row));
      } else if (kind === "Delete" && table === DETAILS) {
        const k = item.Key as Row;
        apply.push(() => details.delete(`${String(k.callId)}|${String(k.sk)}`));
      } else {
        throw new Error(`unexpected ${kind} on ${table}`);
      }
    }
    apply.forEach((f) => f());
    return {};
  });
  // Nothing else may write these tables.
  ddbMock.on(PutCommand).rejects(new Error("unexpected Put"));
  ddbMock.on(DeleteCommand).rejects(new Error("unexpected Delete"));
  ddbMock.on(QueryCommand, { TableName: "slack-test-connections" }).resolves({ Items: [] });
}

function request(
  routeKey: string,
  opts: { body?: unknown; query?: Record<string, string>; callId?: string; user?: typeof ALICE },
): HttpEvent {
  const user = opts.user ?? ALICE;
  return {
    version: "2.0",
    routeKey,
    rawPath: "/notes",
    headers: {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    queryStringParameters: opts.query,
    pathParameters: opts.callId ? { callId: opts.callId } : undefined,
    requestContext: {
      http: { method: routeKey.split(" ")[0] },
      authorizer: { jwt: { claims: { sub: user.userId, email: user.email }, scopes: [] } },
    },
  } as unknown as HttpEvent;
}
async function call(routeKey: string, opts: Parameters<typeof request>[1] = {}) {
  const result = (await handler(request(routeKey, opts))) as { statusCode: number; body: string };
  return { status: result.statusCode, json: result.body ? JSON.parse(result.body) : undefined };
}
const setTopic = (m: Message, topic: string | null, user = ALICE) =>
  call("PUT /notes/{callId}/topic", {
    callId: m.aiNotes!.callId,
    body: { channelId: m.channelId, sk: m.sk, topic },
    user,
  });
const list = (query: Record<string, string> = {}, user = ALICE) =>
  call("GET /notes", { query, user });
const titles = (r: { json: { notes: Message[] } }) => r.json.notes.map((m) => m.aiNotes!.summary);

beforeEach(() => {
  resetMocks();
  mockChannels(GENERAL, dmRow(ALICE.userId, BOB.userId));
  fakeTables();
});

describe("filing a meeting under a topic (PUT /notes/{callId}/topic)", () => {
  it("writes the card, the call's note-details and everyone's pointer, and tells them", async () => {
    const m = card(1);
    const res = await setTopic(m, "  Client   Call ");
    expect(res.status).toBe(200);
    expect(res.json.aiNotes.topic).toBe("Client Call");
    expect((messages.get(msgKey(m as unknown as Row))!.aiNotes as AiNotes).topic).toBe(
      "Client Call",
    );
    expect(details.get(`${m.aiNotes!.callId}|topic`)).toMatchObject({
      topic: "Client Call",
      setBy: ALICE.userId,
    });
    for (const user of [ALICE, BOB]) {
      expect(pointers.get(ptrKey({ userId: user.userId, sk: m.sk }))).toMatchObject({
        topic: "Client Call",
        topicKey: meetingTopicKey(user.userId, "client call"),
      });
    }
    expect(sentEvents().every(([, e]) => e.type === "message.updated")).toBe(true);
  });

  it("is cleared with null, everywhere", async () => {
    const m = card(1);
    await setTopic(m, "Planning");
    expect((await setTopic(m, null)).status).toBe(200);
    expect((messages.get(msgKey(m as unknown as Row))!.aiNotes as AiNotes).topic).toBeUndefined();
    expect(details.has(`${m.aiNotes!.callId}|topic`)).toBe(false);
    expect(pointers.get(ptrKey({ userId: BOB.userId, sk: m.sk }))).not.toHaveProperty("topicKey");
  });

  it("is only for people in the call, on the card of that call", async () => {
    const m = card(1);
    expect((await setTopic(m, "Planning", CAROL)).status).toBe(404);
    const other = card(2);
    const wrongCall = await call("PUT /notes/{callId}/topic", {
      callId: other.aiNotes!.callId,
      body: { channelId: m.channelId, sk: m.sk, topic: "Planning" },
    });
    expect(wrongCall.status).toBe(404);
    expect((await setTopic(m, "x".repeat(41))).status).toBe(400);
    expect(details.size).toBe(0);
  });

  it("never creates a pointer for someone who hasn't one", async () => {
    const m = card(1);
    pointers.delete(ptrKey({ userId: BOB.userId, sk: m.sk }));
    expect((await setTopic(m, "Retro")).status).toBe(200);
    expect(pointers.has(ptrKey({ userId: BOB.userId, sk: m.sk }))).toBe(false);
  });
});

describe("browsing by topic", () => {
  it("lists one topic's notes through the index, newest first, whatever the spelling", async () => {
    const [a, b, c] = [card(1), card(2), card(3)];
    await setTopic(a, "Daily Sync");
    await setTopic(c, "daily  sync");
    await setTopic(b, "Planning", BOB);
    const daily = await list({ topic: "DAILY SYNC" });
    expect(titles(daily)).toEqual(["Meeting 3", "Meeting 1"]);
    const query = ddbMock.commandCalls(QueryCommand, { TableName: POINTERS }).at(-1)!.args[0].input;
    expect(query).toMatchObject({
      IndexName: NOTES_BY_TOPIC_INDEX,
      KeyConditionExpression: "topicKey = :k",
      ScanIndexForward: false,
    });
    // Set by Bob, filed for Alice too.
    expect(titles(await list({ topic: "planning" }))).toEqual(["Meeting 2"]);
    expect(titles(await list())).toEqual(["Meeting 3", "Meeting 2", "Meeting 1"]);
    expect((await list({ topic: "x".repeat(41) })).status).toBe(400);
  });

  it("pages a topic with a cursor", async () => {
    for (let n = 1; n <= 23; n++) await setTopic(card(n), "Planning");
    const first = await list({ topic: "Planning" });
    expect(first.json.notes).toHaveLength(20);
    const second = await list({ topic: "Planning", cursor: first.json.nextCursor });
    expect(titles(second)).toEqual(["Meeting 3", "Meeting 2", "Meeting 1"]);
    expect(second.json.nextCursor).toBeNull();
    const startKey = ddbMock.commandCalls(QueryCommand, { TableName: POINTERS }).at(-1)!.args[0]
      .input.ExclusiveStartKey;
    expect(startKey).toMatchObject({ userId: ALICE.userId, topicKey: `${ALICE.userId}#planning` });
  });

  it("counts your topics, most notes first, in their newest spelling", async () => {
    const [a, b, c, d] = [card(1), card(2), card(3), card(4)];
    await setTopic(a, "planning");
    await setTopic(b, "Client Call");
    await setTopic(d, "Planning");
    await setTopic(c, "Planning");
    card(5); // no topic
    const res = await call("GET /notes/topics", {});
    expect(res.json.topics).toEqual([
      { topic: "Planning", count: 3 },
      { topic: "Client Call", count: 1 },
    ]);
    expect((await call("GET /notes/topics", { user: CAROL })).json.topics).toEqual([]);
  });
});
