import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { allDaySpan, zonedMidnight } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handler } from "../src/handlers/calendar";
import * as cognito from "../src/lib/cognito";
import type { HttpEvent } from "../src/lib/http";
import * as push from "../src/lib/push";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents } from "./helpers";

const CAROL = { userId: "user-carol", email: "carol@example.com" };
const ADMIN = { userId: "user-admin", email: "admin@example.com", groups: ["admins"] };
const GUEST = { userId: "user-guest", email: "guest@example.com", groups: ["guests"] };
const EVENTS = "slack-test-events";
const BALANCES = "slack-test-vacation-balances";
const USERS = "slack-test-users";
const connections = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
  { connectionId: "conn-carol", userId: CAROL.userId },
  { connectionId: "conn-admin", userId: ADMIN.userId, role: "admin" },
  { connectionId: "conn-guest", userId: GUEST.userId, role: "guest" },
];
/** Connection ids that received a calendar.* push, sorted. */
const pushed = () =>
  sentEvents()
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));

// "Today" is a Monday, so requests can start this week.
const TODAY = "2026-10-19";
const NOW = zonedMidnight(TODAY) + 9 * 3_600_000;

function request(
  routeKey: string,
  opts: {
    user?: { userId: string; email: string; groups?: string[] };
    params?: Record<string, string>;
    query?: Record<string, string>;
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
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(user.groups && { "cognito:groups": `[${user.groups.join(" ")}]` }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
}

const call = async (...args: Parameters<typeof request>) => {
  const result = (await handler(request(...args))) as { statusCode: number; body: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
};

const holidayRow = {
  eventId: "ev_01HOLIDAY0000000000000000H",
  type: "holiday",
  title: "Día de los Difuntos",
  description: "",
  allDay: true,
  ...allDaySpan("2026-11-02", "2026-11-02"),
  startDate: "2026-11-02",
  endDate: "2026-11-02",
  year: "2026",
  createdBy: ADMIN.userId,
  createdAt: 1,
  updatedAt: 1,
};
const meetingRow = {
  eventId: "ev_01MEETING0000000000000000M",
  type: "meeting",
  title: "Daily standup",
  description: "",
  allDay: false,
  startAt: zonedMidnight("2026-11-03") + 10 * 3_600_000,
  endAt: zonedMidnight("2026-11-03") + 10.5 * 3_600_000,
  year: "2026",
  participants: new Set([ALICE.userId, BOB.userId]),
  createdBy: ALICE.userId,
  createdAt: 2,
  updatedAt: 2,
};
const vacationRow = (status: string, userId = BOB.userId) => ({
  eventId: "ev_01VACATION000000000000000V",
  type: "vacation",
  title: "Vacation",
  description: "",
  allDay: true,
  ...allDaySpan("2026-11-03", "2026-11-06"),
  startDate: "2026-11-03",
  endDate: "2026-11-06",
  year: "2026",
  participants: new Set([userId]),
  status,
  days: 4,
  note: "Beach",
  createdBy: userId,
  createdAt: 3,
  updatedAt: 3,
});

const transactItems = (n = 0) =>
  ddbMock.commandCalls(TransactWriteCommand)[n]?.args[0].input.TransactItems ?? [];

let sendPush: MockInstance<typeof push.sendPush>;

beforeEach(() => {
  resetMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  sendPush = vi.spyOn(push, "sendPush").mockResolvedValue(1);
  vi.spyOn(cognito, "adminUserIds").mockResolvedValue([ADMIN.userId]);
  ddbMock.on(QueryCommand, { TableName: EVENTS }).resolves({ Items: [] });
  ddbMock.on(GetCommand, { TableName: EVENTS }).resolves({});
  ddbMock.on(GetCommand, { TableName: BALANCES }).resolves({});
  ddbMock.on(GetCommand, { TableName: USERS }).resolves({});
  ddbMock.on(BatchGetCommand).resolves({
    Responses: { [USERS]: [{ userId: BOB.userId }, { userId: CAROL.userId }] },
  });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({ Items: connections });
});

describe("listing", () => {
  it("returns what the caller may see, in a month, querying the years it spans", async () => {
    ddbMock
      .on(QueryCommand, { TableName: EVENTS })
      .resolves({
        Items: [holidayRow, meetingRow, vacationRow("pending"), vacationRow("approved")],
      });

    const { status, body } = await call("GET /calendar/events", {
      user: CAROL,
      query: { from: "2026-11-01", to: "2026-12-06" },
    });

    expect(status).toBe(200);
    // Carol: the holiday and the approved vacation; not Alice & Bob's meeting, not a pending request.
    expect(body.events.map((e: { type: string; status?: string }) => [e.type, e.status])).toEqual([
      ["holiday", undefined],
      ["vacation", "approved"],
    ]);
    expect(body.events[1].participants).toEqual([BOB.userId]);
    const years = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input.ExpressionAttributeValues?.[":year"]);
    expect(years).toEqual(["2026"]);
  });

  it("looks back into the previous year for events still running in January", async () => {
    await call("GET /calendar/events", { query: { from: "2027-01-01", to: "2027-02-06" } });
    const years = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input.ExpressionAttributeValues?.[":year"]);
    expect(years).toEqual(["2026", "2027"]);
  });

  it("admins see pending requests; guests and bad ranges are refused", async () => {
    ddbMock.on(QueryCommand, { TableName: EVENTS }).resolves({ Items: [vacationRow("pending")] });
    const admin = await call("GET /calendar/events", {
      user: ADMIN,
      query: { from: "2026-11-01", to: "2026-11-30" },
    });
    expect(admin.body.events).toHaveLength(1);
    expect(
      (
        await call("GET /calendar/events", {
          user: GUEST,
          query: { from: "2026-11-01", to: "2026-11-30" },
        })
      ).status,
    ).toBe(403);
    expect((await call("GET /calendar/events", { query: { from: "2026-11-01" } })).status).toBe(
      400,
    );
    expect(
      (await call("GET /calendar/events", { query: { from: "2026-11-01", to: "2027-11-30" } }))
        .status,
    ).toBe(400);
  });
});

describe("meetings", () => {
  it("creates a meeting with the organizer among the participants and tells them", async () => {
    const startAt = zonedMidnight("2026-11-04") + 15 * 3_600_000;
    const { status, body } = await call("POST /calendar/events", {
      body: {
        type: "meeting",
        title: "Client call",
        startAt,
        endAt: startAt + 3_600_000,
        participants: [BOB.userId, BOB.userId],
      },
    });

    expect(status).toBe(201);
    expect(body.event).toMatchObject({
      type: "meeting",
      title: "Client call",
      allDay: false,
      participants: [ALICE.userId, BOB.userId],
      createdBy: ALICE.userId,
    });
    expect(body.event.eventId).toMatch(/^ev_[0-9A-Z]{26}$/);
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.TableName).toBe(EVENTS);
    expect(put.Item?.year).toBe("2026");
    expect(put.Item?.participants).toBeInstanceOf(Set);
    expect(pushed()).toEqual(["conn-alice", "conn-bob"]);
    expect(sentEvents()[0]![1]).toMatchObject({ type: "calendar.event_created", by: ALICE.userId });
    // Bob isn't in front of the app: Web Push.
    expect(sendPush).toHaveBeenCalledWith(
      [BOB.userId],
      expect.objectContaining({
        title: "alice invited you to “Client call”",
        url: "/app/calendar",
      }),
    );
  });

  it("refuses unknown or guest participants, and guests as organizers", async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [USERS]: [] } });
    const startAt = zonedMidnight("2026-11-04") + 15 * 3_600_000;
    const body = { type: "meeting", title: "x", startAt, endAt: startAt + 3_600_000 };
    expect(
      (await call("POST /calendar/events", { body: { ...body, participants: ["nobody"] } })).status,
    ).toBe(400);
    expect((await call("POST /calendar/events", { user: GUEST, body })).status).toBe(403);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("only the organizer edits or deletes a meeting; dropped guests hear a deletion", async () => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: meetingRow.eventId } })
      .resolves({ Item: meetingRow });
    const params = { id: meetingRow.eventId };

    expect(
      (await call("PUT /calendar/events/{id}", { user: BOB, params, body: { title: "Nope" } }))
        .status,
    ).toBe(403);
    expect((await call("DELETE /calendar/events/{id}", { user: BOB, params })).status).toBe(403);
    // Carol can't even tell it exists.
    expect((await call("DELETE /calendar/events/{id}", { user: CAROL, params })).status).toBe(404);

    const { status, body } = await call("PUT /calendar/events/{id}", {
      params,
      body: { title: "Standup", participants: [CAROL.userId] },
    });
    expect(status).toBe(200);
    expect(body.event).toMatchObject({
      title: "Standup",
      participants: [ALICE.userId, CAROL.userId],
    });
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.ConditionExpression).toContain("updatedAt = :was");
    // Everyone who could see it before gets the deletion, the new audience the update.
    const byType = sentEvents().map(([id, e]) => `${id}:${e.type}`);
    expect(byType).toContain("conn-bob:calendar.event_deleted");
    expect(byType).toContain("conn-carol:calendar.event_updated");
    expect(byType).not.toContain("conn-carol:calendar.event_created");
    expect(sendPush).toHaveBeenCalledWith([CAROL.userId], expect.anything());
  });
});

describe("holidays", () => {
  it("only admins add them; they reach every connection but guests", async () => {
    const body = { type: "holiday", title: "Navidad", startDate: "2026-12-25" };
    expect((await call("POST /calendar/events", { body })).status).toBe(403);

    const { status, body: created } = await call("POST /calendar/events", { user: ADMIN, body });
    expect(status).toBe(201);
    expect(created.event).toMatchObject({
      type: "holiday",
      title: "Navidad",
      allDay: true,
      startDate: "2026-12-25",
      endDate: "2026-12-25",
      startAt: zonedMidnight("2026-12-25"),
      endAt: zonedMidnight("2026-12-26"),
    });
    expect(created.event.participants).toBeUndefined();
    expect(pushed()).toEqual(["conn-admin", "conn-alice", "conn-bob", "conn-carol"]);
  });

  it("admins edit and remove them", async () => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: holidayRow.eventId } })
      .resolves({ Item: holidayRow });
    const params = { id: holidayRow.eventId };
    expect((await call("DELETE /calendar/events/{id}", { params })).status).toBe(403);

    const edited = await call("PUT /calendar/events/{id}", {
      user: ADMIN,
      params,
      body: { startDate: "2026-11-03" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.event).toMatchObject({ startDate: "2026-11-03", endDate: "2026-11-03" });

    expect((await call("DELETE /calendar/events/{id}", { user: ADMIN, params })).status).toBe(204);
    expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
      TableName: EVENTS,
      Key: { eventId: holidayRow.eventId },
    });
  });
});

describe("vacation requests", () => {
  it("charges working days minus holidays, reserving them in the ledger atomically", async () => {
    ddbMock.on(QueryCommand, { TableName: EVENTS }).resolves({ Items: [holidayRow] });
    // Mon Nov 2 (holiday) .. Sun Nov 8: 4 working days.
    const { status, body } = await call("POST /calendar/events", {
      user: BOB,
      body: { type: "vacation", startDate: "2026-11-02", endDate: "2026-11-08", note: " Beach " },
    });

    expect(status).toBe(201);
    expect(body.event).toMatchObject({
      type: "vacation",
      status: "pending",
      days: 4,
      note: "Beach",
      participants: [BOB.userId],
      startDate: "2026-11-02",
      endDate: "2026-11-08",
    });
    // The ledger row is created with the statutory allowance if missing…
    const ensure = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(ensure).toMatchObject({
      TableName: BALANCES,
      Item: { userId: BOB.userId, year: "2026", allowance: 15, used: 0, pending: 0 },
      ConditionExpression: "attribute_not_exists(userId)",
    });
    // …and the event + reservation are one transaction under the allowance condition.
    const [put, update] = transactItems();
    expect(put!.Put).toMatchObject({ TableName: EVENTS, Item: { status: "pending", days: 4 } });
    expect(update!.Update).toMatchObject({
      TableName: BALANCES,
      Key: { userId: BOB.userId, year: "2026" },
      ConditionExpression: "used + pending + :days <= allowance",
      ExpressionAttributeValues: { ":days": 4 },
    });
    // Pending: the requester and admins see it, others don't.
    expect(pushed()).toEqual(["conn-admin", "conn-bob"]);
    expect(sendPush).toHaveBeenCalledWith(
      [ADMIN.userId],
      expect.objectContaining({ title: "bob requested vacation" }),
    );
  });

  it("refuses when the ledger condition fails, saying how many days are left", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(new TransactionCanceledException({ message: "cancelled", $metadata: {} }));
    ddbMock
      .on(GetCommand, { TableName: BALANCES, Key: { userId: ALICE.userId, year: "2026" } })
      .resolves({
        Item: { userId: ALICE.userId, year: "2026", allowance: 15, used: 10, pending: 3 },
      });

    const { status, body } = await call("POST /calendar/events", {
      body: { type: "vacation", startDate: "2026-11-09", endDate: "2026-11-13" },
    });

    expect(status).toBe(400);
    expect(body.message).toBe("Those dates need 5 working days but you have 2 left in 2026");
    expect(pushed()).toEqual([]);
  });

  it("rejects the past, weekends only, overlaps with your own requests, and guests", async () => {
    const vacation = { type: "vacation" };
    expect(
      (
        await call("POST /calendar/events", {
          body: { ...vacation, startDate: "2026-10-16", endDate: "2026-10-16" },
        })
      ).body.message,
    ).toBe("A vacation can't start in the past");
    expect(
      (
        await call("POST /calendar/events", {
          body: { ...vacation, startDate: "2026-10-24", endDate: "2026-10-25" },
        })
      ).body.message,
    ).toBe("Those dates have no working days");
    ddbMock.on(QueryCommand, { TableName: EVENTS }).resolves({ Items: [vacationRow("pending")] });
    expect(
      (
        await call("POST /calendar/events", {
          user: BOB,
          body: { ...vacation, startDate: "2026-11-06", endDate: "2026-11-10" },
        })
      ).body.message,
    ).toBe("You already have a pending request on those dates");
    expect(
      (
        await call("POST /calendar/events", {
          user: GUEST,
          body: { ...vacation, startDate: "2026-11-06", endDate: "2026-11-10" },
        })
      ).status,
    ).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("can't be edited; the requester cancels a pending one and gets the days back", async () => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: vacationRow("pending").eventId } })
      .resolves({ Item: vacationRow("pending") });
    const params = { id: vacationRow("pending").eventId };

    expect(
      (await call("PUT /calendar/events/{id}", { user: BOB, params, body: { title: "x" } })).status,
    ).toBe(400);
    expect((await call("DELETE /calendar/events/{id}", { user: CAROL, params })).status).toBe(404);
    expect((await call("DELETE /calendar/events/{id}", { user: ALICE, params })).status).toBe(404);

    expect((await call("DELETE /calendar/events/{id}", { user: BOB, params })).status).toBe(204);
    const [del, release] = transactItems();
    expect(del!.Delete).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "#status = :status",
      ExpressionAttributeValues: { ":status": "pending" },
    });
    expect(release!.Update).toMatchObject({
      Key: { userId: BOB.userId, year: "2026" },
      UpdateExpression: "SET pending = pending - :days, updatedAt = :now",
      ConditionExpression: "pending >= :days",
      ExpressionAttributeValues: expect.objectContaining({ ":days": 4 }),
    });
    expect(sentEvents().map(([, e]) => e.type)).toContain("calendar.event_deleted");
  });

  it("an approved vacation is cancelled by an admin only, releasing used days", async () => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: vacationRow("approved").eventId } })
      .resolves({ Item: vacationRow("approved") });
    const params = { id: vacationRow("approved").eventId };

    expect((await call("DELETE /calendar/events/{id}", { user: BOB, params })).status).toBe(403);
    expect((await call("DELETE /calendar/events/{id}", { user: ADMIN, params })).status).toBe(204);
    expect(transactItems()[1]!.Update).toMatchObject({
      UpdateExpression: "SET used = used - :days, updatedAt = :now",
      ConditionExpression: "used >= :days",
    });
  });
});

describe("decisions", () => {
  const params = { id: vacationRow("pending").eventId };

  beforeEach(() => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: params.id } })
      .resolves({ Item: vacationRow("pending") });
  });

  it("approving moves the days from pending to used and tells everyone", async () => {
    const { status, body } = await call("PUT /calendar/vacations/{id}/status", {
      user: ADMIN,
      params,
      body: { status: "approved", note: "Enjoy" },
    });

    expect(status).toBe(200);
    expect(body.event).toMatchObject({
      status: "approved",
      decidedBy: ADMIN.userId,
      decidedAt: NOW,
      decisionNote: "Enjoy",
    });
    const [event, ledger] = transactItems();
    expect(event!.Update).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "#status = :pending",
      ExpressionAttributeValues: expect.objectContaining({ ":status": "approved" }),
    });
    expect(ledger!.Update).toMatchObject({
      TableName: BALANCES,
      Key: { userId: BOB.userId, year: "2026" },
      UpdateExpression: "SET pending = pending - :days, used = used + :days, updatedAt = :now",
      ConditionExpression: "pending >= :days",
    });
    expect(pushed()).toEqual(["conn-admin", "conn-alice", "conn-bob", "conn-carol"]);
    expect(sentEvents()[0]![1]).toMatchObject({
      type: "calendar.event_updated",
      decision: "approved",
    });
    expect(sendPush).toHaveBeenCalledWith(
      [BOB.userId],
      expect.objectContaining({
        title: "Vacation approved",
        body: "2026-11-03 → 2026-11-06 · Enjoy",
      }),
    );
  });

  it("rejecting gives the days back and stays between the requester and the admins", async () => {
    const { status, body } = await call("PUT /calendar/vacations/{id}/status", {
      user: ADMIN,
      params,
      body: { status: "rejected" },
    });
    expect(status).toBe(200);
    expect(body.event.status).toBe("rejected");
    expect(transactItems()[1]!.Update).toMatchObject({
      UpdateExpression: "SET pending = pending - :days, updatedAt = :now",
    });
    expect(pushed()).toEqual(["conn-admin", "conn-bob"]);
  });

  it("members can't decide; a decided request isn't decided twice", async () => {
    expect(
      (await call("PUT /calendar/vacations/{id}/status", { params, body: { status: "approved" } }))
        .status,
    ).toBe(403);
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: params.id } })
      .resolves({ Item: vacationRow("approved") });
    expect(
      (
        await call("PUT /calendar/vacations/{id}/status", {
          user: ADMIN,
          params,
          body: { status: "rejected" },
        })
      ).status,
    ).toBe(409);
    ddbMock
      .on(TransactWriteCommand)
      .rejects(new TransactionCanceledException({ message: "cancelled", $metadata: {} }));
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: params.id } })
      .resolves({ Item: vacationRow("pending") });
    expect(
      (
        await call("PUT /calendar/vacations/{id}/status", {
          user: ADMIN,
          params,
          body: { status: "approved" },
        })
      ).status,
    ).toBe(409);
  });
});

describe("balances", () => {
  it("gives a member their own row (statutory default) and an admin everyone's", async () => {
    const mine = await call("GET /calendar/balances");
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({
      year: "2026",
      mine: { userId: ALICE.userId, year: "2026", allowance: 15, used: 0, pending: 0 },
      balances: [],
    });

    ddbMock.on(QueryCommand, { TableName: BALANCES, IndexName: "byYear" }).resolves({
      Items: [{ userId: BOB.userId, year: "2025", allowance: 15, used: 4, pending: 0 }],
    });
    const all = await call("GET /calendar/balances", { user: ADMIN, query: { year: "2025" } });
    expect(all.body.balances.map((b: { userId: string }) => b.userId)).toEqual([
      BOB.userId,
      ADMIN.userId,
    ]);
    expect((await call("GET /calendar/balances", { query: { year: "25" } })).status).toBe(400);
    expect((await call("GET /calendar/balances", { user: GUEST })).status).toBe(403);
  });

  it("an admin sets an allowance, never below what's already requested", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { userId: BOB.userId, year: "2026", allowance: 20, used: 4, pending: 0 },
    });
    expect(
      (
        await call("PUT /calendar/balances/{userId}/{year}", {
          params: { userId: BOB.userId, year: "2026" },
          body: { allowance: 20 },
        })
      ).status,
    ).toBe(403);

    const { status, body } = await call("PUT /calendar/balances/{userId}/{year}", {
      user: ADMIN,
      params: { userId: BOB.userId, year: "2026" },
      body: { allowance: 20 },
    });
    expect(status).toBe(200);
    expect(body.balance).toEqual({
      userId: BOB.userId,
      year: "2026",
      allowance: 20,
      used: 4,
      pending: 0,
    });
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      ConditionExpression: "used + pending <= :allowance",
    });
    expect(
      (
        await call("PUT /calendar/balances/{userId}/{year}", {
          user: ADMIN,
          params: { userId: BOB.userId, year: "2026" },
          body: { allowance: 100 },
        })
      ).status,
    ).toBe(400);
  });
});
