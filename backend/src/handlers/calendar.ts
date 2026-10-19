import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  allDaySpan,
  canSeeEvent,
  countVacationDays,
  CreateEventSchema,
  dateInZone,
  datesOverlap,
  describeEventWhen,
  isCalendarEventId,
  ListEventsQuerySchema,
  remainingDays,
  UpdateBalanceSchema,
  UpdateEventSchema,
  VacationDecisionSchema,
  vacationOwner,
  YearSchema,
  yearOf,
  type CalendarEvent,
  dmMembers,
  meetingCardText,
  newMessageSk,
  type CalendarPushEvent,
  type HolidayEvent,
  type MeetingCard,
  type MeetingEvent,
  type Message,
  type UpdateEventInput,
  type VacationBalance,
  type VacationEvent,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { activeUserIds, deliver, listConnections, type LiveConnection } from "../lib/broadcast";
import {
  balancesOfYear,
  ensureBalance,
  eventAudience,
  eventsBetween,
  getBalance,
  getEvent,
  holidayDatesBetween,
  toBalance,
  toItem,
  vacationsOf,
} from "../lib/calendar";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { adminUserIds } from "../lib/cognito";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { findSentMessage } from "../lib/messages";
import { displayNameOf } from "../lib/notify";
import { sendPush } from "../lib/push";
import { guestsAmong, unknownUsers } from "../lib/users";

/**
 * Company calendar HTTP API: meetings, vacation requests and national
 * holidays in the `events` table, the yearly vacation allowance in the
 * `vacation-balances` ledger (one row per person and year).
 *
 * The ledger is the authority on the 15 days: a request reserves its days
 * (`pending`) in the same transaction that writes the event, under the
 * condition `used + pending + days <= allowance`, so two requests can't both
 * squeeze in; approving moves them to `used`, rejecting or cancelling gives
 * them back. Every write is pushed over the chat WebSocket (`calendar.*`) to
 * whoever may see the event, like the Task Manager's `board.*` pushes.
 */

const CALENDAR_PATH = "/app/calendar";

// --- Helpers ---------------------------------------------------------------------

const isAdmin = (caller: HttpCaller) => caller.role === "admin";

function requireMember(caller: HttpCaller): void {
  if (caller.role === "guest") throw forbidden("Guests don't have a calendar");
}

function requireAdmin(caller: HttpCaller, what: string): void {
  if (!isAdmin(caller)) throw forbidden(`Only an admin can ${what}`);
}

/** The event if it exists and `caller` may see it; a 404 otherwise. */
async function visibleEvent(eventId: string, caller: HttpCaller): Promise<CalendarEvent> {
  const event = isCalendarEventId(eventId) ? await getEvent(eventId) : null;
  if (!event || !canSeeEvent(event, caller)) throw notFound("Event not found");
  return event;
}

/**
 * Pushes `push` to every live connection allowed to see `event`. The write
 * already succeeded: a failed push is logged, never a failed request.
 */
async function notify(event: CalendarEvent, push: CalendarPushEvent): Promise<LiveConnection[]> {
  try {
    const connections = await listConnections();
    await deliver(connections.filter(eventAudience(event)), () => push);
    return connections;
  } catch (err) {
    log.error("calendar broadcast failed", { eventId: event.eventId, ...errorFields(err) });
    return [];
  }
}

/** Web Push to `userIds` who aren't in front of the app; best effort. */
async function pushOffline(
  userIds: string[],
  connections: LiveConnection[],
  payload: { title: string; body: string; tag: string },
): Promise<void> {
  try {
    const active = activeUserIds(connections);
    const offline = [...new Set(userIds)].filter((id) => !active.has(id));
    if (offline.length === 0) return;
    const sent = await sendPush(offline, { ...payload, url: CALENDAR_PATH, sound: "default" });
    log.info("calendar push sent", { tag: payload.tag, recipients: offline.length, sent });
  } catch (err) {
    log.error("calendar push failed", { tag: payload.tag, ...errorFields(err) });
  }
}

/** Members among `userIds` other than the caller; they must exist and not be guests. */
async function checkParticipants(userIds: string[], caller: HttpCaller): Promise<string[]> {
  const others = [...new Set(userIds)].filter((id) => id !== caller.userId);
  if (others.length === 0) return [];
  const missing = await unknownUsers(others);
  if (missing.length > 0) throw new HttpError(400, `Unknown users: ${missing.join(", ")}`);
  const guests = await guestsAmong(others);
  if (guests.length > 0) throw new HttpError(400, "Guests can't be invited to meetings");
  return others;
}

/** `[startAt, endAt)` and the dates of a meeting from its (validated) input. */
function meetingSpan(input: {
  allDay: boolean;
  startAt?: number;
  endAt?: number;
  startDate?: string;
  endDate?: string;
}): Pick<MeetingEvent, "allDay" | "startAt" | "endAt" | "startDate" | "endDate"> {
  if (input.allDay) {
    const { startDate, endDate } = input as { startDate: string; endDate: string };
    return { allDay: true, ...allDaySpan(startDate, endDate), startDate, endDate };
  }
  return { allDay: false, startAt: input.startAt!, endAt: input.endAt! };
}

const isTransactionFailure = (err: unknown) => err instanceof TransactionCanceledException;

// --- Listing ----------------------------------------------------------------------

async function listEvents(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  requireMember(caller);
  const parsed = ListEventsQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid range");
  }
  const events = (await eventsBetween(parsed.data.from, parsed.data.to)).filter((e) =>
    canSeeEvent(e, caller),
  );
  return json(200, { events });
}

// --- Creating ----------------------------------------------------------------------

async function createEvent(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  requireMember(caller);
  const input = parseBody(CreateEventSchema, event);
  switch (input.type) {
    case "meeting":
      return createMeeting(input, caller);
    case "holiday":
      return createHoliday(input, caller);
    case "vacation":
      return createVacation(input, caller);
  }
}

async function createMeeting(
  input: Extract<ReturnType<typeof CreateEventSchema.parse>, { type: "meeting" }>,
  caller: HttpCaller,
): Promise<HttpResult> {
  if (input.channelId !== undefined) {
    return createDmMeeting({ ...input, channelId: input.channelId }, caller);
  }
  const invited = await checkParticipants(input.participants, caller);
  const now = Date.now();
  const meeting: MeetingEvent = {
    eventId: `ev_${ulid()}`,
    type: "meeting",
    title: input.title,
    description: input.description,
    ...meetingSpan(input),
    participants: [caller.userId, ...invited].sort((a, b) => a.localeCompare(b)),
    createdBy: caller.userId,
    createdAt: now,
    updatedAt: now,
  };
  await putNew(meeting);
  log.info("meeting created", { eventId: meeting.eventId, userId: caller.userId });
  const connections = await notify(meeting, {
    type: "calendar.event_created",
    event: meeting,
    by: caller.userId,
  });
  if (invited.length > 0) {
    const organizer = await displayNameOf(caller.userId, caller.email);
    await pushOffline(invited, connections, {
      title: `${organizer} invited you to “${meeting.title}”`,
      body: describeEventWhen(meeting),
      tag: meeting.eventId,
    });
  }
  return json(201, { event: meeting });
}

/**
 * A meeting scheduled from a direct message: its participants are the DM's
 * two people (from the channel id, never the body), and a "meeting scheduled"
 * card is posted in the conversation. The event and the message are written
 * in one transaction, so the calendar and the chat never disagree; the
 * pushes afterwards are best effort, as everywhere (a reload shows both).
 */
async function createDmMeeting(
  input: Extract<ReturnType<typeof CreateEventSchema.parse>, { type: "meeting" }> & {
    channelId: string;
  },
  caller: HttpCaller,
): Promise<HttpResult> {
  const { channelId } = input;
  const members = dmMembers(channelId);
  const channel = members ? await getAccessibleChannel(channelId, caller.userId) : null;
  if (!members || !channel || channel.type !== "dm") throw notFound("Conversation not found");
  const peers = [...new Set(members)].filter((id) => id !== caller.userId);
  if ((await guestsAmong(peers)).length > 0) {
    throw new HttpError(400, "Guests can't be invited to meetings");
  }

  // A retry of a request that did go through: hand back what it created.
  if (input.clientId) {
    const sent = await findSentMessage(channelId, caller.userId, input.clientId);
    if (sent?.meeting) {
      const event = await getEvent(sent.meeting.eventId);
      log.info("duplicate meeting request ignored", { channelId, eventId: sent.meeting.eventId });
      return json(201, { event, message: sent });
    }
  }

  const now = Date.now();
  const span = meetingSpan(input);
  const participants = [...new Set(members)].sort((a, b) => a.localeCompare(b));
  const meeting: MeetingEvent = {
    eventId: `ev_${ulid()}`,
    type: "meeting",
    title: input.title,
    description: input.description,
    ...span,
    participants,
    createdBy: caller.userId,
    createdAt: now,
    updatedAt: now,
  };
  const card: MeetingCard = {
    eventId: meeting.eventId,
    title: meeting.title,
    description: meeting.description,
    allDay: false,
    startAt: meeting.startAt,
    endAt: meeting.endAt,
    participants,
  };
  const message: Message = {
    messageId: ulid(now),
    channelId,
    sk: newMessageSk(now),
    userId: caller.userId,
    userEmail: caller.email,
    text: meetingCardText(card),
    attachments: [],
    createdAt: now,
    reactions: {},
    kind: "meeting",
    meeting: card,
    ...(input.clientId && { clientId: input.clientId }),
  };
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tables.events,
            Item: toItem(meeting),
            ConditionExpression: "attribute_not_exists(eventId)",
          },
        },
        {
          Put: {
            TableName: tables.messages,
            Item: message,
            ConditionExpression: "attribute_not_exists(sk)",
          },
        },
      ],
    }),
  );
  log.info("meeting scheduled from DM", {
    eventId: meeting.eventId,
    channelId,
    userId: caller.userId,
  });

  // The calendar push to the participants, the chat push to the conversation.
  let connections: LiveConnection[] = [];
  try {
    connections = await listConnections();
    const inAudience = channelAudience(channel);
    const sees = eventAudience(meeting);
    await deliver(
      connections.filter((c) => sees(c) || inAudience(c)),
      (c) =>
        sees(c) ? { type: "calendar.event_created", event: meeting, by: caller.userId } : null,
    );
    await deliver(connections, (c) =>
      inAudience(c) ? { type: "message.new", message, clientId: input.clientId ?? "" } : null,
    );
  } catch (err) {
    log.error("calendar broadcast failed", { eventId: meeting.eventId, ...errorFields(err) });
  }
  if (peers.length > 0) {
    const organizer = await displayNameOf(caller.userId, caller.email);
    await pushOffline(peers, connections, {
      title: `${organizer} invited you to “${meeting.title}”`,
      body: describeEventWhen(meeting),
      tag: meeting.eventId,
    });
  }
  return json(201, { event: meeting, message });
}

async function createHoliday(
  input: Extract<ReturnType<typeof CreateEventSchema.parse>, { type: "holiday" }>,
  caller: HttpCaller,
): Promise<HttpResult> {
  requireAdmin(caller, "add national holidays");
  const endDate = input.endDate ?? input.startDate;
  const now = Date.now();
  const holiday: HolidayEvent = {
    eventId: `ev_${ulid()}`,
    type: "holiday",
    title: input.title,
    description: input.description,
    allDay: true,
    ...allDaySpan(input.startDate, endDate),
    startDate: input.startDate,
    endDate,
    createdBy: caller.userId,
    createdAt: now,
    updatedAt: now,
  };
  await putNew(holiday);
  log.info("holiday created", { eventId: holiday.eventId, userId: caller.userId });
  await notify(holiday, { type: "calendar.event_created", event: holiday, by: caller.userId });
  return json(201, { event: holiday });
}

/**
 * A vacation request: its cost in days is fixed now (working days, minus the
 * national holidays already on the calendar), reserved in the ledger by the
 * same transaction that writes the event.
 */
async function createVacation(
  input: Extract<ReturnType<typeof CreateEventSchema.parse>, { type: "vacation" }>,
  caller: HttpCaller,
): Promise<HttpResult> {
  const { startDate, endDate } = input;
  if (startDate < dateInZone(Date.now())) {
    throw new HttpError(400, "A vacation can't start in the past");
  }
  const days = countVacationDays(startDate, endDate, await holidayDatesBetween(startDate, endDate));
  if (days === 0) throw new HttpError(400, "Those dates have no working days");
  const clash = (await vacationsOf(caller.userId, startDate, endDate)).find((v) =>
    datesOverlap(v, { startDate, endDate }),
  );
  if (clash) {
    throw new HttpError(400, `You already have a ${clash.status} request on those dates`);
  }

  const year = yearOf(startDate);
  await ensureBalance(caller.userId, year);
  const now = Date.now();
  const vacation: VacationEvent = {
    eventId: `ev_${ulid()}`,
    type: "vacation",
    title: "Vacation",
    description: "",
    allDay: true,
    ...allDaySpan(startDate, endDate),
    startDate,
    endDate,
    participants: [caller.userId],
    status: "pending",
    days,
    note: input.note,
    createdBy: caller.userId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.events,
              Item: toItem(vacation),
              ConditionExpression: "attribute_not_exists(eventId)",
            },
          },
          {
            Update: {
              TableName: tables.vacationBalances,
              Key: { userId: caller.userId, year },
              UpdateExpression: "SET pending = pending + :days, updatedAt = :now",
              ConditionExpression: "used + pending + :days <= allowance",
              ExpressionAttributeValues: { ":days": days, ":now": now },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (!isTransactionFailure(err)) throw err;
    const balance = await getBalance(caller.userId, year);
    const left = remainingDays(balance);
    throw new HttpError(
      400,
      `Those dates need ${days} working ${days === 1 ? "day" : "days"} but you have ${left} left in ${year}`,
    );
  }
  log.info("vacation requested", { eventId: vacation.eventId, userId: caller.userId, days, year });
  const connections = await notify(vacation, {
    type: "calendar.event_created",
    event: vacation,
    by: caller.userId,
  });
  const admins = (await adminUserIds()).filter((id) => id !== caller.userId);
  if (admins.length > 0) {
    const who = await displayNameOf(caller.userId, caller.email);
    await pushOffline(admins, connections, {
      title: `${who} requested vacation`,
      body: `${describeEventWhen(vacation)} · ${days} ${days === 1 ? "day" : "days"}`,
      tag: vacation.eventId,
    });
  }
  return json(201, { event: vacation, balance: await getBalance(caller.userId, year) });
}

async function putNew(event: CalendarEvent): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tables.events,
      Item: toItem(event),
      ConditionExpression: "attribute_not_exists(eventId)",
    }),
  );
}

// --- Editing -----------------------------------------------------------------------

/**
 * Meetings are edited by their organizer, holidays by an admin; a vacation
 * can't be edited (cancel and request again, so the ledger stays simple).
 * The row is rewritten whole: the span fields depend on each other.
 */
async function updateEvent(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const eventId = pathParam(event, "id");
  const before = await visibleEvent(eventId, caller);
  const patch = parseBody(UpdateEventSchema, event);
  let updated: CalendarEvent;
  if (before.type === "meeting") {
    if (before.createdBy !== caller.userId) throw forbidden("Only the organizer can edit it");
    updated = await editedMeeting(before, patch, caller);
  } else if (before.type === "holiday") {
    requireAdmin(caller, "edit national holidays");
    updated = editedHoliday(before, patch);
  } else {
    throw new HttpError(400, "A vacation request can't be edited: cancel it and request again");
  }
  updated.updatedAt = Date.now();
  await ddb.send(
    new PutCommand({
      TableName: tables.events,
      Item: toItem(updated),
      ConditionExpression: "attribute_exists(eventId) AND updatedAt = :was",
      ExpressionAttributeValues: { ":was": before.updatedAt },
    }),
  );
  log.info("event updated", { eventId, userId: caller.userId, fields: Object.keys(patch) });
  // Whoever may still see it gets the update; anyone dropped from a meeting, a deletion.
  let connections: LiveConnection[] = [];
  try {
    connections = await listConnections();
    const sees = eventAudience(updated);
    const saw = eventAudience(before);
    await deliver(
      connections.filter((c) => saw(c) || sees(c)),
      (c) =>
        sees(c)
          ? { type: "calendar.event_updated", event: updated, by: caller.userId }
          : { type: "calendar.event_deleted", eventId, by: caller.userId },
    );
  } catch (err) {
    log.error("calendar broadcast failed", { eventId, ...errorFields(err) });
  }
  if (updated.type === "meeting" && before.type === "meeting") {
    const newcomers = updated.participants.filter((id) => !before.participants.includes(id));
    if (newcomers.length > 0) {
      const organizer = await displayNameOf(caller.userId, caller.email);
      await pushOffline(newcomers, connections, {
        title: `${organizer} invited you to “${updated.title}”`,
        body: describeEventWhen(updated),
        tag: updated.eventId,
      });
    }
  }
  return json(200, { event: updated });
}

async function editedMeeting(
  before: MeetingEvent,
  patch: UpdateEventInput,
  caller: HttpCaller,
): Promise<MeetingEvent> {
  const wantsSpan =
    patch.allDay !== undefined ||
    patch.startAt !== undefined ||
    patch.endAt !== undefined ||
    patch.startDate !== undefined ||
    patch.endDate !== undefined;
  let span: ReturnType<typeof meetingSpan> = {
    allDay: before.allDay,
    startAt: before.startAt,
    endAt: before.endAt,
    startDate: before.startDate,
    endDate: before.endDate,
  };
  if (wantsSpan) {
    // Re-validate the merged span with the creation rules (length, order, required pair).
    const merged = CreateEventSchema.safeParse({
      type: "meeting",
      title: patch.title ?? before.title,
      allDay: patch.allDay ?? before.allDay,
      startAt: patch.startAt ?? (patch.allDay ? undefined : before.startAt),
      endAt: patch.endAt ?? (patch.allDay ? undefined : before.endAt),
      startDate: patch.startDate ?? before.startDate,
      endDate: patch.endDate ?? before.endDate,
    });
    if (!merged.success) {
      throw new HttpError(400, merged.error.issues[0]?.message ?? "Invalid dates");
    }
    span = meetingSpan(merged.data as Parameters<typeof meetingSpan>[0]);
  }
  const participants =
    patch.participants === undefined
      ? before.participants
      : [caller.userId, ...(await checkParticipants(patch.participants, caller))].sort((a, b) =>
          a.localeCompare(b),
        );
  const next: MeetingEvent = {
    ...before,
    title: patch.title ?? before.title,
    description: patch.description ?? before.description,
    allDay: span.allDay,
    startAt: span.startAt,
    endAt: span.endAt,
    participants,
  };
  if (span.allDay) {
    next.startDate = span.startDate;
    next.endDate = span.endDate;
  } else {
    delete next.startDate;
    delete next.endDate;
  }
  return next;
}

function editedHoliday(before: HolidayEvent, patch: UpdateEventInput): HolidayEvent {
  const startDate = patch.startDate ?? before.startDate;
  const endDate = patch.endDate ?? (patch.startDate && !patch.endDate ? startDate : before.endDate);
  const check = CreateEventSchema.safeParse({
    type: "holiday",
    title: patch.title ?? before.title,
    startDate,
    endDate,
  });
  if (!check.success) throw new HttpError(400, check.error.issues[0]?.message ?? "Invalid dates");
  return {
    ...before,
    title: patch.title ?? before.title,
    description: patch.description ?? before.description,
    ...allDaySpan(startDate, endDate),
    startDate,
    endDate,
  };
}

// --- Deleting / cancelling ---------------------------------------------------------------

async function deleteEvent(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const eventId = pathParam(event, "id");
  const existing = await visibleEvent(eventId, caller);
  if (existing.type === "vacation") {
    await cancelVacation(existing, caller);
  } else {
    if (existing.type === "holiday") requireAdmin(caller, "remove national holidays");
    else if (existing.createdBy !== caller.userId && !isAdmin(caller)) {
      throw forbidden("Only the organizer can delete it");
    }
    await ddb.send(new DeleteCommand({ TableName: tables.events, Key: { eventId } }));
  }
  log.info("event deleted", { eventId, type: existing.type, userId: caller.userId });
  await notify(existing, { type: "calendar.event_deleted", eventId, by: caller.userId });
  return json(204);
}

/**
 * The requester cancels a pending request; an admin cancels any. The days
 * go back to the ledger (from `pending` or `used`) in the same transaction.
 */
async function cancelVacation(vacation: VacationEvent, caller: HttpCaller): Promise<void> {
  const owner = vacationOwner(vacation);
  if (!isAdmin(caller)) {
    if (owner !== caller.userId) throw forbidden("Only the requester can cancel it");
    if (vacation.status === "approved") {
      throw forbidden("An approved vacation can only be cancelled by an admin");
    }
  }
  const field = vacation.status === "approved" ? "used" : "pending";
  const release =
    vacation.status === "rejected"
      ? [] // its days were given back when it was rejected
      : [
          {
            Update: {
              TableName: tables.vacationBalances,
              Key: { userId: owner, year: yearOf(vacation.startDate) },
              UpdateExpression: `SET ${field} = ${field} - :days, updatedAt = :now`,
              ConditionExpression: `${field} >= :days`,
              ExpressionAttributeValues: { ":days": vacation.days, ":now": Date.now() },
            },
          },
        ];
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tables.events,
              Key: { eventId: vacation.eventId },
              ConditionExpression: "#status = :status",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":status": vacation.status },
            },
          },
          ...release,
        ],
      }),
    );
  } catch (err) {
    if (!isTransactionFailure(err)) throw err;
    throw new HttpError(409, "The request changed meanwhile; reload and try again");
  }
}

// --- Deciding -------------------------------------------------------------------------

/** An admin approves or rejects a pending request; the ledger moves its days accordingly. */
async function decideVacation(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  requireAdmin(caller, "approve or reject vacations");
  const eventId = pathParam(event, "id");
  const existing = await visibleEvent(eventId, caller);
  if (existing.type !== "vacation") throw new HttpError(400, "Not a vacation request");
  if (existing.status !== "pending") {
    throw new HttpError(409, `This request was already ${existing.status}`);
  }
  const { status, note } = parseBody(VacationDecisionSchema, event);
  const now = Date.now();
  const ledger =
    status === "approved"
      ? "SET pending = pending - :days, used = used + :days, updatedAt = :now"
      : "SET pending = pending - :days, updatedAt = :now";
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tables.events,
              Key: { eventId },
              UpdateExpression:
                "SET #status = :status, decidedBy = :by, decidedAt = :now, decisionNote = :note, updatedAt = :now",
              ConditionExpression: "#status = :pending",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": status,
                ":pending": "pending",
                ":by": caller.userId,
                ":now": now,
                ":note": note,
              },
            },
          },
          {
            Update: {
              TableName: tables.vacationBalances,
              Key: { userId: vacationOwner(existing), year: yearOf(existing.startDate) },
              UpdateExpression: ledger,
              ConditionExpression: "pending >= :days",
              ExpressionAttributeValues: { ":days": existing.days, ":now": now },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (!isTransactionFailure(err)) throw err;
    throw new HttpError(409, "The request changed meanwhile; reload and try again");
  }
  const decided: VacationEvent = {
    ...existing,
    status,
    decidedBy: caller.userId,
    decidedAt: now,
    decisionNote: note,
    updatedAt: now,
  };
  log.info("vacation decided", { eventId, status, userId: caller.userId });
  // Approved: now company-wide. Rejected: the requester (and admins) only.
  const connections = await notify(decided, {
    type: "calendar.event_updated",
    event: decided,
    by: caller.userId,
    decision: status,
  });
  await pushOffline([vacationOwner(existing)], connections, {
    title: `Vacation ${status}`,
    body: `${describeEventWhen(decided)}${note ? ` · ${note}` : ""}`,
    tag: eventId,
  });
  return json(200, { event: decided });
}

// --- Balances ------------------------------------------------------------------------

/** My ledger row for `year` (default: this year); an admin gets everyone's. */
async function listBalances(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  requireMember(caller);
  const raw = event.queryStringParameters?.year ?? yearOf(dateInZone(Date.now()));
  const year = YearSchema.safeParse(raw);
  if (!year.success) throw new HttpError(400, "year must be YYYY");
  const mine = await getBalance(caller.userId, year.data);
  const balances: VacationBalance[] = isAdmin(caller) ? await balancesOfYear(year.data) : [];
  if (isAdmin(caller) && !balances.some((b) => b.userId === caller.userId)) balances.push(mine);
  return json(200, { year: year.data, mine, balances });
}

/** An admin sets someone's allowance for a year (never below what's already used or pending). */
async function setAllowance(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  requireAdmin(caller, "change vacation allowances");
  const userId = pathParam(event, "userId");
  const year = YearSchema.safeParse(pathParam(event, "year"));
  if (!year.success) throw new HttpError(400, "year must be YYYY");
  const { allowance } = parseBody(UpdateBalanceSchema, event);
  if ((await unknownUsers([userId])).length > 0) throw notFound("User not found");
  await ensureBalance(userId, year.data);
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.vacationBalances,
        Key: { userId, year: year.data },
        UpdateExpression: "SET allowance = :allowance, updatedAt = :now",
        ConditionExpression: "used + pending <= :allowance",
        ExpressionAttributeValues: { ":allowance": allowance, ":now": Date.now() },
        ReturnValues: "ALL_NEW",
      }),
    );
    log.info("allowance set", { userId, year: year.data, allowance, by: caller.userId });
    return json(200, { balance: toBalance(Attributes ?? { userId, year: year.data, allowance }) });
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(400, "The allowance can't be lower than the days already requested");
    }
    throw err;
  }
}

// --- Router ----------------------------------------------------------------------

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /calendar/events": listEvents,
  "POST /calendar/events": createEvent,
  "PUT /calendar/events/{id}": updateEvent,
  "DELETE /calendar/events/{id}": deleteEvent,
  "PUT /calendar/vacations/{id}/status": decideVacation,
  "GET /calendar/balances": listBalances,
  "PUT /calendar/balances/{userId}/{year}": setAllowance,
};

export const handler = httpHandler(async (event, caller) => {
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});
