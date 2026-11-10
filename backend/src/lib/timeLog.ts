import { DeleteCommand, GetCommand, paginateQuery, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  canDeleteTimeEntry,
  canLogTime,
  CreateTimeEntrySchema,
  managesTimeRates,
  seesAllTime,
  SetTimeRateSchema,
  UserIdSchema,
  type Channel,
  type TimeEntry,
  type TimeLogResponse,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, listConnections } from "./broadcast";
import { channelAudience, getAccessibleChannel } from "./channels";
import { ddb, tables } from "./ddb";
import {
  forbidden,
  HttpError,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "./http";
import { errorFields, log } from "./logger";
import { defaultDisplayName } from "./users";

// ---------------------------------------------------------------------------
// Hours (Phase 60): a channel's time log. Rows of `time-log`, by channel:
//   - `entry#<date>#<ulid>`: one entry (who, the day, minutes, what was done);
//   - `rate#<userId>`: that person's hourly rate in this channel (admins only).
// Anyone in the channel logs their own hours (externals too); the team sees
// everyone's, an external only theirs; rates never leave for a non-admin.
// ---------------------------------------------------------------------------

const ENTRY = "entry#";
const RATE = "rate#";

const entrySk = (date: string, entryId: string) => `${ENTRY}${date}#${entryId}`;

interface EntryRow extends TimeEntry {
  sk: string;
}

/** The channel in the path, if the caller may use it (an external: only their private channels). */
async function channelOf(event: HttpEvent, caller: HttpCaller, write: boolean): Promise<Channel> {
  const channelId = decodeURIComponent(pathParam(event, "channelId"));
  const channel = await getAccessibleChannel(channelId, caller, { allowArchived: !write });
  if (!channel) throw notFound("Channel not found");
  if (channel.type === "dm") throw new HttpError(400, "Direct messages have no time log");
  if (write && !canLogTime(channel)) throw new HttpError(409, "This channel is archived");
  return channel;
}

async function rowsOf(channelId: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const pages = paginateQuery(
    { client: ddb },
    {
      TableName: tables.timeLog,
      KeyConditionExpression: "channelId = :c",
      ExpressionAttributeValues: { ":c": channelId },
    },
  );
  for await (const page of pages) rows.push(...(page.Items ?? []));
  return rows;
}

const toEntry = (row: Record<string, unknown>): TimeEntry => {
  const { sk: _sk, ...entry } = row as unknown as EntryRow;
  void _sk;
  return entry;
};

/** Tells the channel its log changed (they read it again). Never fails the request. */
async function announce(channel: Channel): Promise<void> {
  try {
    const inAudience = channelAudience(channel);
    await deliver(await listConnections(), (c) =>
      inAudience(c) ? { type: "time.updated", channelId: channel.channelId } : null,
    );
  } catch (err) {
    log.warn("time log broadcast failed", { channelId: channel.channelId, ...errorFields(err) });
  }
}

/** `GET /channels/{channelId}/time`: its entries (newest day first) and, for admins, the rates. */
export async function listTime(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await channelOf(event, caller, false);
  const rows = await rowsOf(channel.channelId);
  const all = rows.filter((r) => String(r.sk).startsWith(ENTRY));
  const visible = seesAllTime(caller.role) ? all : all.filter((r) => r.userId === caller.userId);
  const entries = visible
    .map(toEntry)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const body: TimeLogResponse = { entries };
  if (managesTimeRates(caller.role)) {
    body.rates = Object.fromEntries(
      rows
        .filter((r) => String(r.sk).startsWith(RATE) && typeof r.hourlyRate === "number")
        .map((r) => [String(r.sk).slice(RATE.length), r.hourlyRate as number]),
    );
  }
  return json(200, body);
}

/** `POST /channels/{channelId}/time`: the caller logs their own hours for a day. */
export async function logTime(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await channelOf(event, caller, true);
  const input = parseBody(CreateTimeEntrySchema, event);
  const now = Date.now();
  const entry: TimeEntry = {
    entryId: ulid(now),
    channelId: channel.channelId,
    userId: caller.userId,
    userName: defaultDisplayName(caller.email),
    date: input.date,
    minutes: input.minutes,
    description: input.description,
    createdAt: now,
  };
  await ddb.send(
    new PutCommand({
      TableName: tables.timeLog,
      Item: { ...entry, sk: entrySk(entry.date, entry.entryId) },
    }),
  );
  log.info("time logged", {
    channelId: channel.channelId,
    userId: caller.userId,
    minutes: entry.minutes,
    date: entry.date,
  });
  await announce(channel);
  return json(201, { entry });
}

/** `DELETE /channels/{channelId}/time/{date}/{entryId}`: whoever logged it, or an admin. */
export async function deleteTime(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const channel = await channelOf(event, caller, true);
  const key = {
    channelId: channel.channelId,
    sk: entrySk(pathParam(event, "date"), pathParam(event, "entryId")),
  };
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.timeLog, Key: key }));
  // An external can't tell someone else's entry exists.
  if (!Item || (!seesAllTime(caller.role) && Item.userId !== caller.userId)) {
    throw notFound("Entry not found");
  }
  if (!canDeleteTimeEntry(toEntry(Item), caller.userId, caller.role)) {
    throw forbidden("Only whoever logged it, or an admin, can delete it");
  }
  await ddb.send(new DeleteCommand({ TableName: tables.timeLog, Key: key }));
  log.info("time entry deleted", { channelId: channel.channelId, userId: caller.userId });
  await announce(channel);
  return json(204);
}

/** `PUT /channels/{channelId}/time/rates/{userId}`: an admin sets someone's hourly rate (0 clears it). */
export async function setTimeRate(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  if (!managesTimeRates(caller.role)) throw forbidden("Only an admin sets hourly rates");
  const channel = await channelOf(event, caller, true);
  const userId = UserIdSchema.safeParse(pathParam(event, "userId"));
  if (!userId.success) throw new HttpError(400, "Invalid user id");
  const { hourlyRate } = parseBody(SetTimeRateSchema, event);
  const key = { channelId: channel.channelId, sk: `${RATE}${userId.data}` };
  if (hourlyRate === 0) {
    await ddb.send(new DeleteCommand({ TableName: tables.timeLog, Key: key }));
  } else {
    await ddb.send(
      new PutCommand({
        TableName: tables.timeLog,
        Item: { ...key, hourlyRate, setBy: caller.userId, updatedAt: Date.now() },
      }),
    );
  }
  // Never the amount in the logs.
  log.info("time rate set", {
    channelId: channel.channelId,
    userId: caller.userId,
    cleared: hourlyRate === 0,
  });
  await announce(channel);
  return json(200, { userId: userId.data, hourlyRate });
}
