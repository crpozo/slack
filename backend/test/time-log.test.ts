import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { TimeEntry, TimeLogResponse } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/messages";
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

// Phase 60: a channel's time log (hours per person; rates and costs for admins).

const TABLE = "slack-test-time-log";
const DEV = { userId: "user-dev", email: "dev@contractor.com" };
const CLIENT = privateRow("ch_client", ALICE.userId, [ALICE.userId, BOB.userId, DEV.userId]);
type Who = { userId: string; email: string };

let rows: Map<string, Record<string, unknown>>;

function request(
  routeKey: string,
  user: Who,
  opts: {
    groups?: string;
    body?: unknown;
    params?: Record<string, string>;
    channelId?: string;
  } = {},
): HttpEvent {
  return {
    version: "2.0",
    routeKey,
    rawPath: "/",
    headers: {},
    pathParameters: { channelId: opts.channelId ?? "ch_client", ...opts.params },
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    isBase64Encoded: false,
    requestContext: {
      http: { method: routeKey.split(" ")[0], path: "/" },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(opts.groups && { "cognito:groups": opts.groups }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
}
async function call(...args: Parameters<typeof request>) {
  const r = (await handler(request(...args))) as { statusCode: number; body?: string };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined };
}
const log = (user: Who, groups: string | undefined, minutes: number, date = "2026-11-10") =>
  call("POST /channels/{channelId}/time", user, {
    groups,
    body: { date, minutes, description: "API de pagos" },
  });
const list = async (user: Who, groups?: string) =>
  (await call("GET /channels/{channelId}/time", user, { groups })).json as TimeLogResponse;

beforeEach(() => {
  resetMocks();
  rows = new Map();
  mockChannels(GENERAL, CLIENT);
  ddbMock.on(ScanCommand).resolves({
    Items: [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-dev", userId: DEV.userId, role: "guest" },
      { connectionId: "conn-carol", userId: "user-carol" },
    ],
  });
  const key = (k: { channelId: string; sk: string }) => `${k.channelId}|${k.sk}`;
  ddbMock.on(PutCommand, { TableName: TABLE }).callsFake(({ Item }) => {
    rows.set(key(Item), structuredClone(Item));
    return {};
  });
  ddbMock.on(GetCommand, { TableName: TABLE }).callsFake(({ Key }) => ({
    Item: structuredClone(rows.get(key(Key))),
  }));
  ddbMock.on(DeleteCommand, { TableName: TABLE }).callsFake(({ Key }) => {
    rows.delete(key(Key));
    return {};
  });
  ddbMock.on(QueryCommand, { TableName: TABLE }).callsFake(({ ExpressionAttributeValues }) => ({
    Items: [...rows.values()].filter((r) => r.channelId === ExpressionAttributeValues[":c"]),
  }));
});

describe("logging hours in a channel", () => {
  it("anyone in the channel logs their own, externals too; the channel hears it changed", async () => {
    const res = await log(DEV, "[guests]", 150);
    expect(res.status).toBe(201);
    expect(res.json.entry).toMatchObject({
      channelId: "ch_client",
      userId: DEV.userId,
      userName: "dev",
      date: "2026-11-10",
      minutes: 150,
      description: "API de pagos",
    });
    // Its members' connections only (Carol isn't in the channel).
    expect(sentEvents().sort()).toEqual([
      ["conn-alice", { type: "time.updated", channelId: "ch_client" }],
      ["conn-dev", { type: "time.updated", channelId: "ch_client" }],
    ]);
  });

  it("the team sees everyone's hours; an external only their own; rates only an admin", async () => {
    await log(DEV, "[guests]", 120);
    await log(BOB, undefined, 60, "2026-11-09");
    await call("PUT /channels/{channelId}/time/rates/{userId}", ALICE, {
      groups: "[admins]",
      params: { userId: DEV.userId },
      body: { hourlyRate: 25 },
    });

    const admin = await list(ALICE, "[admins]");
    expect(admin.entries.map((e) => [e.userId, e.minutes])).toEqual([
      [DEV.userId, 120],
      [BOB.userId, 60],
    ]);
    expect(admin.rates).toEqual({ [DEV.userId]: 25 });

    const member = await list(BOB);
    expect(member.entries).toHaveLength(2);
    expect(member.rates).toBeUndefined();

    const external = await list(DEV, "[guests]");
    expect(external.entries.map((e: TimeEntry) => e.userId)).toEqual([DEV.userId]);
    expect(JSON.stringify(external)).not.toContain("hourlyRate");
    expect(external.rates).toBeUndefined();
  });

  it("only an admin sets a rate; 0 clears it", async () => {
    const put = (user: Who, groups: string | undefined, hourlyRate: number) =>
      call("PUT /channels/{channelId}/time/rates/{userId}", user, {
        groups,
        params: { userId: DEV.userId },
        body: { hourlyRate },
      });
    expect((await put(BOB, undefined, 30)).status).toBe(403);
    expect((await put(DEV, "[guests]", 99)).status).toBe(403);
    expect((await put(ALICE, "[admins]", 30)).status).toBe(200);
    expect((await list(ALICE, "[admins]")).rates).toEqual({ [DEV.userId]: 30 });
    await put(ALICE, "[admins]", 0);
    expect((await list(ALICE, "[admins]")).rates).toEqual({});
  });

  it("an entry is deleted by whoever logged it or an admin; an external can't see others'", async () => {
    const mine = (await log(BOB, undefined, 60)).json.entry as TimeEntry;
    const del = (user: Who, groups?: string) =>
      call("DELETE /channels/{channelId}/time/{date}/{entryId}", user, {
        groups,
        params: { date: mine.date, entryId: mine.entryId },
      });
    expect((await del(DEV, "[guests]")).status).toBe(404);
    expect((await del({ userId: "user-x", email: "x@x.ec" })).status).toBe(404); // not in the channel
    expect((await del(BOB)).status).toBe(204);
    expect((await list(BOB)).entries).toEqual([]);
  });

  it("refuses channels the caller can't use, and bad entries", async () => {
    // An external never reaches a public channel.
    const res = await call("POST /channels/{channelId}/time", DEV, {
      groups: "[guests]",
      channelId: "ch_general",
      body: { date: "2026-11-10", minutes: 60, description: "x" },
    });
    expect(res.status).toBe(404);
    expect((await log(BOB, undefined, 0)).status).toBe(400);
    expect((await log(BOB, undefined, 60, "ayer")).status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it("a client reviews every entry and what it's billed, never the internal rates, and can't edit", async () => {
    const BUYER = { userId: "user-buyer", email: "ana@cliente.com" };
    mockChannels(
      GENERAL,
      privateRow("ch_client", ALICE.userId, [ALICE.userId, BOB.userId, DEV.userId, BUYER.userId]),
    );
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "slack-test-users": [
          { userId: BUYER.userId, role: "guest" },
          { userId: DEV.userId, role: "guest" },
          { userId: BOB.userId, role: "member" },
        ],
      },
    });
    await log(DEV, "[guests]", 120);
    await log(BOB, undefined, 90, "2026-11-09");
    const admin = (
      path: string,
      params: Record<string, string>,
      body: unknown,
      groups = "[admins]",
    ) => call(`PUT /channels/{channelId}/time/${path}`, ALICE, { groups, params, body });
    await admin("rates/{userId}", { userId: DEV.userId }, { hourlyRate: 25 });
    await admin("bill-rates/{userId}", { userId: DEV.userId }, { hourlyRate: 60 });
    await admin("bill-rates/{userId}", { userId: BOB.userId }, { hourlyRate: 80 });

    // Not marked yet: an external like any other, only their own (none).
    expect((await list(BUYER, "[guests]")).entries).toEqual([]);
    // Only externals in the channel can be clients; only an admin marks them.
    expect((await admin("clients", {}, { clientIds: [BOB.userId] })).status).toBe(400);
    expect((await admin("clients", {}, { clientIds: ["user-x"] })).status).toBe(400);
    expect(
      (
        await call("PUT /channels/{channelId}/time/clients", BOB, {
          body: { clientIds: [BUYER.userId] },
        })
      ).status,
    ).toBe(403);
    expect((await admin("clients", {}, { clientIds: [BUYER.userId] })).status).toBe(200);

    const view = await list(BUYER, "[guests]");
    expect(view.client).toBe(true);
    expect(view.entries.map((e) => e.userId)).toEqual([DEV.userId, BOB.userId]);
    expect(view.billRates).toEqual({ [DEV.userId]: 60, [BOB.userId]: 80 });
    expect(view.rates).toBeUndefined();
    expect(view.clientIds).toBeUndefined();
    expect(Object.keys(view).sort()).toEqual(["billRates", "client", "entries"]);

    // The admin sees both, and who the clients are; the contractor still only their own.
    const full = await list(ALICE, "[admins]");
    expect(full.rates).toEqual({ [DEV.userId]: 25 });
    expect(full.billRates).toEqual({ [DEV.userId]: 60, [BOB.userId]: 80 });
    expect(full.clientIds).toEqual([BUYER.userId]);
    expect((await list(DEV, "[guests]")).entries).toHaveLength(1);

    // Read-only.
    expect((await log(BUYER, "[guests]", 60)).status).toBe(403);
    const entry = view.entries[0]!;
    const del = await call("DELETE /channels/{channelId}/time/{date}/{entryId}", BUYER, {
      groups: "[guests]",
      params: { date: entry.date, entryId: entry.entryId },
    });
    expect(del.status).toBe(403);
    expect(
      (await admin("bill-rates/{userId}", { userId: DEV.userId }, { hourlyRate: 1 }, "[guests]"))
        .status,
    ).toBe(403);
  });
});
