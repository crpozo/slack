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
import { allDaySpan, dmChannelId, zonedMidnight } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handler } from "../src/handlers/calendar";
import * as cognito from "../src/lib/cognito";
import type { HttpEvent } from "../src/lib/http";
import * as push from "../src/lib/push";
import { ALICE, BOB, ddbMock, dmRow, mockChannels, resetMocks, sentEvents } from "./helpers";

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
  const user: { userId: string; email: string; groups?: string[] } = opts.user ?? ALICE;
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
    ddbMock.on(QueryCommand, { TableName: EVENTS }).resolves({
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
    expect(years).toEqual(["2026", "series"]);
  });

  it("looks back into the previous year for events still running in January", async () => {
    await call("GET /calendar/events", { query: { from: "2027-01-01", to: "2027-02-06" } });
    const years = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input.ExpressionAttributeValues?.[":year"]);
    expect(years).toEqual(["2026", "2027", "series"]);
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
    expect(byType).toContain("conn-alice:calendar.event_updated");
    expect(byType).not.toContain("conn-alice:calendar.event_deleted");
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

describe("meetings scheduled from a direct message", () => {
  const DM = dmChannelId(ALICE.userId, BOB.userId);
  const MESSAGES = "slack-test-messages";
  const startAt = zonedMidnight("2026-11-04") + 15 * 3_600_000;
  const body = {
    type: "meeting",
    title: "Client kickoff",
    description: "Agenda in the doc",
    startAt,
    endAt: startAt + 3_600_000,
    channelId: DM,
    clientId: "c-meet-1",
  };

  beforeEach(() => {
    mockChannels(dmRow(ALICE.userId, BOB.userId));
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({ Items: [] });
  });

  it("writes the event and the card in one transaction, participants from the DM", async () => {
    const { status, body: reply } = await call("POST /calendar/events", { body });

    expect(status).toBe(201);
    expect(reply.event).toMatchObject({
      type: "meeting",
      title: "Client kickoff",
      allDay: false,
      startAt,
      participants: [ALICE.userId, BOB.userId],
      createdBy: ALICE.userId,
    });
    expect(reply.message).toMatchObject({
      channelId: DM,
      userId: ALICE.userId,
      userEmail: ALICE.email,
      kind: "meeting",
      clientId: "c-meet-1",
      attachments: [],
      meeting: {
        eventId: reply.event.eventId,
        title: "Client kickoff",
        description: "Agenda in the doc",
        allDay: false,
        startAt,
        participants: [ALICE.userId, BOB.userId],
      },
    });
    expect(reply.message.text).toMatch(/^📅 Meeting scheduled: Client kickoff · Nov 4, 3:00 PM$/);
    // The event remembers its card, so editing the meeting can rewrite it.
    expect(reply.event).toMatchObject({
      channelId: DM,
      messageId: reply.message.messageId,
      messageSk: reply.message.sk,
    });
    // Nothing written outside the transaction, which holds exactly the pair.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    const [event, message] = transactItems();
    expect(event!.Put).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "attribute_not_exists(eventId)",
      Item: { year: "2026", participants: new Set([ALICE.userId, BOB.userId]) },
    });
    expect(message!.Put).toMatchObject({
      TableName: MESSAGES,
      ConditionExpression: "attribute_not_exists(sk)",
      Item: { channelId: DM, kind: "meeting" },
    });
    // Both people get the calendar push and the chat message; nobody else gets either.
    const byType = sentEvents()
      .map(([id, e]) => `${id}:${e.type}`)
      .sort();
    expect(byType).toEqual([
      "conn-alice:calendar.event_created",
      "conn-alice:message.new",
      "conn-bob:calendar.event_created",
      "conn-bob:message.new",
    ]);
    const chat = sentEvents().find(([, e]) => e.type === "message.new")?.[1] as {
      message: { kind: string };
      clientId: string;
    };
    expect(chat.message.kind).toBe("meeting");
    expect(chat.clientId).toBe("c-meet-1");
    expect(sendPush).toHaveBeenCalledWith(
      [BOB.userId],
      expect.objectContaining({ title: "alice invited you to “Client kickoff”" }),
    );
  });

  it("refuses participants in the body, all-day, channels that aren't your DMs, and guests", async () => {
    expect(
      (await call("POST /calendar/events", { body: { ...body, participants: [CAROL.userId] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST /calendar/events", {
          body: { ...body, allDay: true, startDate: "2026-11-04", endDate: "2026-11-04" },
        })
      ).status,
    ).toBe(400);
    // Carol isn't in Alice & Bob's DM; a channel that doesn't exist (or that you can't see).
    expect((await call("POST /calendar/events", { user: CAROL, body })).status).toBe(404);
    expect(
      (await call("POST /calendar/events", { body: { ...body, channelId: "ch_general" } })).status,
    ).toBe(404);
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [USERS]: [{ userId: BOB.userId, role: "guest" }] },
    });
    const guest = await call("POST /calendar/events", { body });
    expect(guest.status).toBe(400);
    expect(guest.body.message).toBe("Guests can't be invited to meetings");
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("a retried request returns the pair already created instead of a second meeting", async () => {
    const card = {
      eventId: "ev_01MEETING0000000000000000M",
      title: "Client kickoff",
      description: "",
      allDay: false,
      startAt,
      endAt: startAt + 3_600_000,
      participants: [ALICE.userId, BOB.userId],
    };
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({
      Items: [
        {
          messageId: "m1",
          channelId: DM,
          sk: "1#m1",
          userId: ALICE.userId,
          text: "📅 Meeting scheduled: Client kickoff",
          kind: "meeting",
          meeting: card,
          clientId: "c-meet-1",
        },
      ],
    });
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: card.eventId } })
      .resolves({ Item: meetingRow });

    const { status, body: reply } = await call("POST /calendar/events", { body });
    expect(status).toBe(201);
    expect(reply.event.eventId).toBe(card.eventId);
    expect(reply.message.messageId).toBe("m1");
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sentEvents()).toEqual([]);
  });

  describe("editing the meeting keeps the card alive", () => {
    const linkedRow = { ...meetingRow, channelId: DM, messageId: "m1", messageSk: "1#m1" };
    const params = { id: linkedRow.eventId };
    const movedTo = zonedMidnight("2026-11-05") + 16 * 3_600_000;
    const cancelled = (event: string, message: string) =>
      new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [{ Code: event }, { Code: message }],
      });

    beforeEach(() => {
      ddbMock
        .on(GetCommand, { TableName: EVENTS, Key: { eventId: linkedRow.eventId } })
        .resolves({ Item: linkedRow });
    });

    it("rewrites the card in the same transaction and tells the conversation", async () => {
      const { status, body: reply } = await call("PUT /calendar/events/{id}", {
        params,
        body: { title: "Daily standup (moved)", startAt: movedTo, endAt: movedTo + 1_800_000 },
      });
      expect(status).toBe(200);
      expect(reply.event).toMatchObject({ title: "Daily standup (moved)", startAt: movedTo });

      // The event and the card, nothing outside the transaction.
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      const [event, message] = transactItems();
      expect(event!.Put).toMatchObject({
        TableName: EVENTS,
        ConditionExpression: "attribute_exists(eventId) AND updatedAt = :was",
        ExpressionAttributeValues: { ":was": linkedRow.updatedAt },
        Item: { eventId: linkedRow.eventId, startAt: movedTo, messageSk: "1#m1" },
      });
      expect(message!.Update).toMatchObject({
        TableName: MESSAGES,
        Key: { channelId: DM, sk: "1#m1" },
        ConditionExpression: "attribute_exists(sk) AND kind = :kind",
        ExpressionAttributeValues: {
          ":kind": "meeting",
          ":card": {
            eventId: linkedRow.eventId,
            title: "Daily standup (moved)",
            allDay: false,
            startAt: movedTo,
            endAt: movedTo + 1_800_000,
            participants: [ALICE.userId, BOB.userId],
          },
        },
      });
      expect(message!.Update!.ExpressionAttributeValues![":text"]).toMatch(
        /^📅 Meeting scheduled: Daily standup \(moved\) · Nov 5, 4:00 PM$/,
      );

      // Both people get the calendar update and the new card; nobody else does.
      const byType = sentEvents()
        .map(([id, e]) => `${id}:${e.type}`)
        .sort();
      expect(byType).toEqual([
        "conn-alice:calendar.event_updated",
        "conn-alice:message.updated",
        "conn-bob:calendar.event_updated",
        "conn-bob:message.updated",
      ]);
      const chat = sentEvents().find(([, e]) => e.type === "message.updated")?.[1] as {
        channelId: string;
        sk: string;
        messageId: string;
        text: string;
        meeting: { startAt: number };
        isEdited?: boolean;
      };
      expect(chat).toMatchObject({ channelId: DM, sk: "1#m1", messageId: "m1" });
      expect(chat.meeting.startAt).toBe(movedTo);
      expect(chat.isEdited).toBeUndefined();
    });

    it("still edits the meeting when its card was deleted, and says nothing to the chat", async () => {
      ddbMock.on(TransactWriteCommand).rejects(cancelled("None", "ConditionalCheckFailed"));
      const { status } = await call("PUT /calendar/events/{id}", {
        params,
        body: { startAt: movedTo, endAt: movedTo + 1_800_000 },
      });
      expect(status).toBe(200);
      const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(put).toMatchObject({ TableName: EVENTS, Item: { startAt: movedTo } });
      const types = sentEvents().map(([, e]) => e.type);
      expect(types).toContain("calendar.event_updated");
      expect(types).not.toContain("message.updated");
    });

    it("refuses an edit of a meeting that changed meanwhile", async () => {
      ddbMock.on(TransactWriteCommand).rejects(cancelled("ConditionalCheckFailed", "None"));
      const { status } = await call("PUT /calendar/events/{id}", {
        params,
        body: { title: "Too late" },
      });
      expect(status).toBe(409);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(sentEvents()).toEqual([]);
    });
  });
});

describe("cards in each invitee's DM (Phase 34)", () => {
  const MESSAGES = "slack-test-messages";
  const CHANNELS = "slack-test-channels";
  const DM_BOB = dmChannelId(ALICE.userId, BOB.userId);
  const DM_CAROL = dmChannelId(ALICE.userId, CAROL.userId);
  const startAt = zonedMidnight("2026-11-04") + 15 * 3_600_000;

  beforeEach(() => {
    // Alice and Bob already talk; Alice and Carol never did.
    mockChannels(dmRow(ALICE.userId, BOB.userId));
  });

  const messagePuts = () =>
    ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input)
      .filter((input) => input.TableName === MESSAGES);

  it("a calendar meeting posts a card in each invitee's DM, opening the DM when needed", async () => {
    const { status, body } = await call("POST /calendar/events", {
      body: {
        type: "meeting",
        title: "Planning",
        startAt,
        endAt: startAt + 3_600_000,
        participants: [BOB.userId, CAROL.userId],
      },
    });
    expect(status).toBe(201);

    // The event lists its cards before they're posted.
    const eventPut = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(eventPut.TableName).toBe(EVENTS);
    const cards = eventPut.Item?.cards as Array<{ channelId: string; messageSk: string }>;
    expect(cards.map((c) => c.channelId).sort()).toEqual([DM_BOB, DM_CAROL].sort());
    expect(body.event.cards).toHaveLength(2);

    // Carol's DM didn't exist: created like `openDm` does.
    const dmPut = ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input)
      .find((input) => input.TableName === CHANNELS);
    expect(dmPut).toMatchObject({
      Item: { channelId: DM_CAROL, type: "dm", members: [ALICE.userId, CAROL.userId].sort() },
      ConditionExpression: "attribute_not_exists(channelId)",
    });

    // One card per DM, by the organizer, at the ids the event remembers.
    const posted = messagePuts();
    expect(posted).toHaveLength(2);
    for (const put of posted) {
      const ref = cards.find((c) => c.channelId === put.Item?.channelId)!;
      expect(put.Item).toMatchObject({
        kind: "meeting",
        sk: ref.messageSk,
        userId: ALICE.userId,
        meeting: { eventId: body.event.eventId, title: "Planning" },
      });
      expect(put.Item?.text).toMatch(/^📅 Meeting scheduled: Planning/);
    }

    // Each DM's people hear about their card only.
    const chat = sentEvents()
      .filter(([, e]) => e.type === "message.new")
      .map(([id, e]) => `${id}:${(e as { message: { channelId: string } }).message.channelId}`)
      .sort();
    expect(chat).toEqual(
      [
        `conn-alice:${DM_BOB}`,
        `conn-alice:${DM_CAROL}`,
        `conn-bob:${DM_BOB}`,
        `conn-carol:${DM_CAROL}`,
      ].sort(),
    );
  });

  it("a meeting just for yourself posts no card", async () => {
    await call("POST /calendar/events", {
      body: { type: "meeting", title: "Focus", startAt, endAt: startAt + 3_600_000 },
    });
    expect(messagePuts()).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item?.cards).toBeUndefined();
  });

  describe("an existing meeting with cards", () => {
    const cardedRow = {
      ...meetingRow,
      cards: [
        { channelId: DM_BOB, messageId: "mb", messageSk: "1#mb" },
        { channelId: DM_CAROL, messageId: "mc", messageSk: "1#mc" },
      ],
      participants: new Set([ALICE.userId, BOB.userId, CAROL.userId]),
    };
    const params = { id: cardedRow.eventId };

    beforeEach(() => {
      mockChannels(dmRow(ALICE.userId, BOB.userId), dmRow(ALICE.userId, CAROL.userId));
      ddbMock
        .on(GetCommand, { TableName: EVENTS, Key: { eventId: cardedRow.eventId } })
        .resolves({ Item: cardedRow });
    });

    it("an edit rewrites every card with the event, in one transaction", async () => {
      const { status } = await call("PUT /calendar/events/{id}", {
        params,
        body: { title: "Planning (moved)" },
      });
      expect(status).toBe(200);
      const items = transactItems();
      expect(items).toHaveLength(3);
      expect(items.slice(1).map((i) => i.Update?.Key)).toEqual([
        { channelId: DM_BOB, sk: "1#mb" },
        { channelId: DM_CAROL, sk: "1#mc" },
      ]);
      const updates = sentEvents().filter(([, e]) => e.type === "message.updated");
      expect(updates.map(([id]) => id).sort()).toEqual(
        ["conn-alice", "conn-alice", "conn-bob", "conn-carol"].sort(),
      );
    });

    it("dropping someone cancels their card; a newcomer gets one", async () => {
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { [USERS]: [{ userId: BOB.userId }, { userId: ADMIN.userId }] },
      });
      const { status, body } = await call("PUT /calendar/events/{id}", {
        params,
        body: { participants: [BOB.userId, ADMIN.userId] },
      });
      expect(status).toBe(200);
      // Bob's card is rewritten with the event; Carol's goes; the admin's is new.
      expect(
        transactItems()
          .slice(1)
          .map((i) => i.Update?.Key),
      ).toEqual([{ channelId: DM_BOB, sk: "1#mb" }]);
      const DM_ADMIN = dmChannelId(ALICE.userId, ADMIN.userId);
      expect(body.event.cards.map((c: { channelId: string }) => c.channelId)).toEqual([
        DM_BOB,
        DM_ADMIN,
      ]);
      const cancel = ddbMock
        .commandCalls(UpdateCommand)
        .map((c) => c.args[0].input)
        .find((input) => input.TableName === MESSAGES);
      expect(cancel).toMatchObject({ Key: { channelId: DM_CAROL, sk: "1#mc" } });
      expect(cancel?.ExpressionAttributeValues?.[":card"]).toMatchObject({ cancelled: true });
      expect(cancel?.ExpressionAttributeValues?.[":text"]).toBe(
        "📅 Meeting cancelled: Daily standup",
      );
      expect(messagePuts().map((p) => p.Item?.channelId)).toEqual([DM_ADMIN]);
    });

    it("deleting the meeting marks every card cancelled", async () => {
      expect((await call("DELETE /calendar/events/{id}", { params })).status).toBe(204);
      const cancels = ddbMock
        .commandCalls(UpdateCommand)
        .map((c) => c.args[0].input)
        .filter((input) => input.TableName === MESSAGES);
      expect(cancels.map((c) => c.Key)).toEqual([
        { channelId: DM_BOB, sk: "1#mb" },
        { channelId: DM_CAROL, sk: "1#mc" },
      ]);
      expect(cancels.every((c) => c.ExpressionAttributeValues?.[":card"].cancelled)).toBe(true);
      const chat = sentEvents().filter(([, e]) => e.type === "message.updated");
      expect(chat.map(([id]) => id).sort()).toEqual(
        ["conn-alice", "conn-alice", "conn-bob", "conn-carol"].sort(),
      );
    });
  });
});

describe("recurring meetings (Phase 34)", () => {
  const startAt = zonedMidnight("2026-10-26") + 10 * 3_600_000; // a Monday, 10:00
  const weekdays = { freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5] };
  const seriesRow = {
    ...meetingRow,
    eventId: "ev_01SERIES00000000000000000S",
    title: "Standup",
    startAt,
    endAt: startAt + 1_800_000,
    year: "series",
    seriesEndAt: Number.MAX_SAFE_INTEGER,
    recurrence: weekdays,
  };
  const params = { id: seriesRow.eventId };

  beforeEach(() => {
    mockChannels(dmRow(ALICE.userId, BOB.userId));
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: seriesRow.eventId } })
      .resolves({ Item: seriesRow });
  });

  it("stores a series in its own partition with when it ends", async () => {
    const { status, body } = await call("POST /calendar/events", {
      body: {
        type: "meeting",
        title: "Standup",
        startAt,
        endAt: startAt + 1_800_000,
        participants: [BOB.userId],
        recurrence: { ...weekdays, count: 10 },
      },
    });
    expect(status).toBe(201);
    expect(body.event.recurrence).toEqual({ ...weekdays, count: 10 });
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item?.year).toBe("series");
    // Ten weekdays from Mon Oct 26: the last is Fri Nov 6.
    expect(put.Item?.seriesEndAt).toBe(zonedMidnight("2026-11-06") + 10.5 * 3_600_000);
    const card = ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === "slack-test-messages");
    expect(card?.Item?.text).toBe(
      "📅 Meeting scheduled: Standup · Every weekday, 10 times at 10:00 AM",
    );
    expect(sendPush).toHaveBeenCalledWith(
      [BOB.userId],
      expect.objectContaining({ body: expect.stringMatching(/^Every weekday, 10 times · from /) }),
    );
  });

  it("refuses a first date the rule doesn't have", async () => {
    const { status } = await call("POST /calendar/events", {
      body: {
        type: "meeting",
        title: "Standup",
        startAt,
        endAt: startAt + 1_800_000,
        recurrence: { freq: "weekly", byWeekday: [2] },
      },
    });
    expect(status).toBe(400);
  });

  it("lists running series once, skipping ones already over", async () => {
    ddbMock.on(QueryCommand, { TableName: EVENTS }).callsFake((input) =>
      input.ExpressionAttributeValues[":year"] === "series"
        ? {
            Items: [
              seriesRow,
              {
                ...seriesRow,
                eventId: "ev_01OVER000000000000000000O",
                recurrence: { ...weekdays, count: 2 },
                seriesEndAt: 1,
              },
            ],
          }
        : { Items: [] },
    );
    const { body } = await call("GET /calendar/events", {
      query: { from: "2026-12-01", to: "2026-12-31" },
    });
    expect(body.events.map((e: { eventId: string }) => e.eventId)).toEqual([seriesRow.eventId]);
    expect(body.events[0].seriesEndAt).toBeUndefined();
    const seriesQuery = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.ExpressionAttributeValues?.[":year"] === "series");
    expect(seriesQuery?.FilterExpression).toBe("seriesEndAt > :after");
  });

  it("cancels one meeting of the series, rewriting the card", async () => {
    const carded = {
      ...seriesRow,
      channelId: dmChannelId(ALICE.userId, BOB.userId),
      messageId: "m1",
      messageSk: "1#m1",
    };
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: seriesRow.eventId } })
      .resolves({ Item: carded });
    const { status, body } = await call("DELETE /calendar/events/{id}", {
      params,
      query: { occurrence: "2026-10-28" },
    });
    expect(status).toBe(200);
    expect(body.event.exceptions).toEqual(["2026-10-28"]);
    const [event, card] = transactItems();
    expect(event!.Put?.Item).toMatchObject({ exceptions: ["2026-10-28"], year: "series" });
    expect(card!.Update?.ExpressionAttributeValues?.[":card"].exceptions).toEqual(["2026-10-28"]);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    const types = sentEvents()
      .map(([id, e]) => `${id}:${e.type}`)
      .sort();
    expect(types).toContain("conn-bob:calendar.event_updated");
    expect(types).toContain("conn-bob:message.updated");
  });

  it("refuses dates outside the series, single meetings and other people", async () => {
    const at = (occurrence: string, user = ALICE) =>
      call("DELETE /calendar/events/{id}", { user, params, query: { occurrence } });
    expect((await at("2026-10-31")).status).toBe(400); // a Saturday
    expect((await at("not-a-date")).status).toBe(400);
    expect((await at("2026-10-28", BOB)).status).toBe(403);
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: meetingRow.eventId } })
      .resolves({ Item: meetingRow });
    expect(
      (
        await call("DELETE /calendar/events/{id}", {
          params: { id: meetingRow.eventId },
          query: { occurrence: "2026-11-03" },
        })
      ).status,
    ).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("an edit can stop the repeating, dropping its cancelled dates", async () => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: seriesRow.eventId } })
      .resolves({ Item: { ...seriesRow, exceptions: ["2026-10-28"] } });
    const { status, body } = await call("PUT /calendar/events/{id}", {
      params,
      body: { recurrence: null },
    });
    expect(status).toBe(200);
    expect(body.event.recurrence).toBeUndefined();
    expect(body.event.exceptions).toBeUndefined();
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item?.year).toBe("2026");
    expect(put.Item?.seriesEndAt).toBeUndefined();
  });

  it("a new rule keeps only the cancelled dates it still has", async () => {
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: seriesRow.eventId } })
      .resolves({ Item: { ...seriesRow, exceptions: ["2026-10-27", "2026-11-02"] } });
    const { body } = await call("PUT /calendar/events/{id}", {
      params,
      body: { recurrence: { freq: "weekly", byWeekday: [1] } },
    });
    expect(body.event.recurrence).toEqual({ freq: "weekly", interval: 1, byWeekday: [1] });
    expect(body.event.exceptions).toEqual(["2026-11-02"]);
  });
});

describe("meetings posted to a channel (Phase 36)", () => {
  const MESSAGES = "slack-test-messages";
  const CH = "ch_proj";
  const startAt = zonedMidnight("2026-11-04") + 15 * 3_600_000;
  const project = {
    channelId: CH,
    name: "proj",
    type: "private" as const,
    createdBy: ALICE.userId,
    createdAt: 1,
    archived: false,
    members: [ALICE.userId, BOB.userId, CAROL.userId],
  };
  const body = {
    type: "meeting",
    title: "Sprint review",
    startAt,
    endAt: startAt + 3_600_000,
    channelId: CH,
    participants: [BOB.userId, CAROL.userId],
    clientId: "c-proj-1",
  };

  beforeEach(() => {
    mockChannels(project, dmRow(ALICE.userId, BOB.userId));
    ddbMock.on(QueryCommand, { TableName: MESSAGES }).resolves({ Items: [] });
  });

  it("posts the one card in the channel with the event, invitees from the body", async () => {
    const { status, body: reply } = await call("POST /calendar/events", { body });
    expect(status).toBe(201);
    expect(reply.event).toMatchObject({
      participants: [ALICE.userId, BOB.userId, CAROL.userId].sort(),
      channelId: CH,
    });
    expect(reply.event.cards).toBeUndefined(); // no DM cards
    const [event, message] = transactItems();
    expect(event!.Put?.TableName).toBe(EVENTS);
    expect(message!.Put).toMatchObject({
      TableName: MESSAGES,
      Item: { channelId: CH, kind: "meeting", meeting: { title: "Sprint review" } },
    });
    // Nothing posted anywhere else.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    // The channel's people see the card; the invitees the calendar entry and a push.
    const chat = sentEvents()
      .filter(([, e]) => e.type === "message.new")
      .map(([id]) => id)
      .sort();
    expect(chat).toEqual(["conn-alice", "conn-bob", "conn-carol"]);
    expect(sendPush).toHaveBeenCalledWith(
      [BOB.userId, CAROL.userId],
      expect.objectContaining({ title: "alice invited you to “Sprint review”" }),
    );
  });

  it("an edit rewrites the channel card and adds no DM cards for newcomers", async () => {
    const row = {
      ...meetingRow,
      participants: new Set([ALICE.userId, BOB.userId]),
      channelId: CH,
      messageId: "mp",
      messageSk: "1#mp",
    };
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: row.eventId } })
      .resolves({ Item: row });
    const { status, body: reply } = await call("PUT /calendar/events/{id}", {
      params: { id: row.eventId },
      body: { participants: [CAROL.userId] }, // Bob out, Carol in
    });
    expect(status).toBe(200);
    expect(
      transactItems()
        .slice(1)
        .map((i) => i.Update?.Key),
    ).toEqual([{ channelId: CH, sk: "1#mp" }]);
    expect(reply.event.cards).toBeUndefined();
    expect(reply.event.channelId).toBe(CH);
    expect(ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.TableName)).toEqual([]);
  });

  it("deleting it marks the channel card cancelled", async () => {
    const row = { ...meetingRow, channelId: CH, messageId: "mp", messageSk: "1#mp" };
    ddbMock
      .on(GetCommand, { TableName: EVENTS, Key: { eventId: row.eventId } })
      .resolves({ Item: row });
    expect(
      (await call("DELETE /calendar/events/{id}", { params: { id: row.eventId } })).status,
    ).toBe(204);
    const cancel = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === MESSAGES);
    expect(cancel).toMatchObject({ Key: { channelId: CH, sk: "1#mp" } });
    expect(cancel?.ExpressionAttributeValues?.[":card"]).toMatchObject({ cancelled: true });
  });

  it("only in channels you can post in", async () => {
    const outsider = await call("POST /calendar/events", {
      user: { ...CAROL, userId: "user-zed" },
      body,
    });
    expect(outsider.status).toBe(404);
    mockChannels({ ...project, archived: true });
    expect((await call("POST /calendar/events", { body })).status).toBe(404);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
