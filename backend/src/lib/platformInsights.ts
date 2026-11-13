import type Anthropic from "@anthropic-ai/sdk";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, paginateQuery, paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  addDays,
  dateInZone,
  dayOfWeek,
  PLATFORM_INSIGHTS_COOLDOWN_SECONDS,
  PLATFORM_INSIGHTS_DAYS,
  zonedMidnight,
  type Channel,
  type InsightsChannel,
  type InsightsPerson,
  type PlatformAnalysis,
  type PlatformMetrics,
  type PlatformReport,
  type Task,
  type UserProfile,
} from "@mindfultech/shared";
import { z } from "zod";
import { NOTES_MODEL } from "./callNotes";
import { scanChannels } from "./channels";
import { ddb, tables } from "./ddb";
import { optionalSecret } from "./secret";

// ---------------------------------------------------------------------------
// Platform Insights (Phase 64): the numbers of how the team uses the app, and
// what the model would improve. Counts only: of a message, who wrote it, when
// and whether it carried a file or a reply; never its text. Of a task, its
// state and dates; never its title. Direct messages are one group.
// ---------------------------------------------------------------------------

/** Who may see it: e-mail addresses, comma-separated, in an SSM parameter (never in the code). */
export const insightsOwners = optionalSecret("INSIGHTS_OWNERS", "INSIGHTS_OWNERS_PARAMETER");

export async function isInsightsOwner(email: string): Promise<boolean> {
  const mine = email.trim().toLowerCase();
  if (!mine) return false;
  const owners = ((await insightsOwners.get()) ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return owners.includes(mine);
}

/** What is read of a message: nothing it says. */
export interface MessageFact {
  channelId: string;
  userId: string;
  createdAt: number;
  reply: boolean;
  files: number;
  voice: boolean;
  /** A call's AI-notes card: how long the call was, in minutes. */
  callMinutes?: number;
}

export interface TimeRow {
  channelId: string;
  sk: string;
  userId?: string;
  minutes?: number;
  date?: string;
  hourlyRate?: number;
}

const DAY_MS = 86_400_000;
const STALE_TASK_MS = 14 * DAY_MS;
/** A channel's messages are read up to this many (a busy one is still counted well). */
const MAX_MESSAGES_PER_CHANNEL = 8_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Everything in `metrics`, from rows already read (pure: tested without a table). */
export function buildMetrics(input: {
  users: UserProfile[];
  channels: Channel[];
  /** Messages of the period and of the one before it. */
  messages: MessageFact[];
  tasks: Array<
    Pick<
      Task,
      "boardId" | "status" | "assigneeId" | "createdAt" | "updatedAt" | "doneAt" | "isArchived"
    >
  >;
  time: TimeRow[];
  now: number;
}): PlatformMetrics {
  const { users, channels, tasks, time, now } = input;
  const to = dateInZone(now);
  const from = addDays(to, -(PLATFORM_INSIGHTS_DAYS - 1));
  const since = zonedMidnight(from);
  const previousSince = since - PLATFORM_INSIGHTS_DAYS * DAY_MS;
  const current = input.messages.filter((m) => m.createdAt >= since);
  const previous = input.messages.filter(
    (m) => m.createdAt >= previousSince && m.createdAt < since,
  );
  const channelOf = new Map(channels.map((c) => [c.channelId, c]));
  const guests = new Set(users.filter((u) => u.role === "guest").map((u) => u.userId));

  // Messages.
  const perDay = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) perDay.set(d, 0);
  const perHour = Array<number>(24).fill(0);
  const perWeekday = Array<number>(7).fill(0);
  let outsideHours = 0;
  const byPerson = new Map<string, { messages: number; days: Set<string>; last: number }>();
  const byChannel = new Map<string, { messages: number; people: Set<string> }>();
  let inDirectMessages = 0;
  for (const m of current) {
    const date = dateInZone(m.createdAt);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
    const hour = Math.min(23, Math.floor((m.createdAt - zonedMidnight(date)) / 3_600_000));
    perHour[hour]! += 1;
    const weekday = (dayOfWeek(date) + 6) % 7; // Monday first
    perWeekday[weekday]! += 1;
    if (weekday >= 5 || hour < 8 || hour >= 18) outsideHours += 1;
    const person = byPerson.get(m.userId) ?? { messages: 0, days: new Set<string>(), last: 0 };
    person.messages += 1;
    person.days.add(date);
    person.last = Math.max(person.last, m.createdAt);
    byPerson.set(m.userId, person);
    const channel = byChannel.get(m.channelId) ?? { messages: 0, people: new Set<string>() };
    channel.messages += 1;
    channel.people.add(m.userId);
    byChannel.set(m.channelId, channel);
    if (channelOf.get(m.channelId)?.type === "dm") inDirectMessages += 1;
  }

  // Tasks.
  const live = tasks.filter((t) => !t.isArchived);
  const open = live.filter((t) => t.status !== "DONE");
  const done = tasks.filter((t) => t.doneAt != null && t.doneAt >= since);
  const daysToDone = done.map((t) => (t.doneAt! - t.createdAt) / DAY_MS).sort((a, b) => a - b);
  const byStatus: Record<string, number> = {};
  for (const t of live) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const openBy = new Map<string, number>();
  for (const t of open)
    if (t.assigneeId) openBy.set(t.assigneeId, (openBy.get(t.assigneeId) ?? 0) + 1);
  const doneBy = new Map<string, number>();
  for (const t of done)
    if (t.assigneeId) doneBy.set(t.assigneeId, (doneBy.get(t.assigneeId) ?? 0) + 1);

  // Hours.
  const rates = new Map<string, number>(); // `${channelId} ${userId}` → per hour
  for (const r of time) {
    if (r.sk.startsWith("rate#") && typeof r.hourlyRate === "number") {
      rates.set(`${r.channelId} ${r.sk.slice(5)}`, r.hourlyRate);
    }
  }
  const hoursBy = new Map<string, number>();
  const timeByChannel = new Map<string, { minutes: number; cost: number; priced: boolean }>();
  for (const r of time) {
    if (!r.sk.startsWith("entry#") || !r.minutes || !r.date || r.date < from || r.date > to)
      continue;
    if (r.userId) hoursBy.set(r.userId, (hoursBy.get(r.userId) ?? 0) + r.minutes / 60);
    const entry = timeByChannel.get(r.channelId) ?? { minutes: 0, cost: 0, priced: false };
    entry.minutes += r.minutes;
    const rate = rates.get(`${r.channelId} ${r.userId ?? ""}`);
    if (rate !== undefined) {
      entry.cost += (r.minutes / 60) * rate;
      entry.priced = true;
    }
    timeByChannel.set(r.channelId, entry);
  }
  const timeChannels = [...timeByChannel.entries()].map(([id, t]) => ({
    name: nameOfChannel(channelOf.get(id)),
    hours: round1(t.minutes / 60),
    cost: t.priced ? Math.round(t.cost) : null,
  }));

  const people: InsightsPerson[] = users
    .map((u) => {
      const p = byPerson.get(u.userId);
      return {
        name: u.displayName || "Sin nombre",
        role: u.role ?? "member",
        messages: p?.messages ?? 0,
        activeDays: p?.days.size ?? 0,
        lastActive: p ? dateInZone(p.last) : null,
        openTasks: openBy.get(u.userId) ?? 0,
        tasksDone: doneBy.get(u.userId) ?? 0,
        hoursLogged: round1(hoursBy.get(u.userId) ?? 0),
      };
    })
    .sort((a, b) => b.messages - a.messages);

  const rooms = channels.filter((c) => c.type !== "dm" && !c.archived);
  const channelList: InsightsChannel[] = rooms
    .map((c) => ({
      name: c.name,
      type: c.type,
      messages: byChannel.get(c.channelId)?.messages ?? 0,
      people: byChannel.get(c.channelId)?.people.size ?? 0,
      lastMessage: c.lastMessageAt ? dateInZone(c.lastMessageAt) : null,
      hasExternals: (c.members ?? []).some((id) => guests.has(id)),
    }))
    .sort((a, b) => b.messages - a.messages);

  const calls = current.filter((m) => m.callMinutes !== undefined);
  return {
    from,
    to,
    days: PLATFORM_INSIGHTS_DAYS,
    people: {
      total: users.length,
      active: people.filter((p) => p.messages > 0).length,
      guests: guests.size,
      list: people,
    },
    messages: {
      total: current.length,
      previous: previous.length,
      inChannels: current.length - inDirectMessages,
      inDirectMessages,
      replies: current.filter((m) => m.reply).length,
      withFiles: current.filter((m) => m.files > 0).length,
      voice: current.filter((m) => m.voice).length,
      perDay: [...perDay.entries()].map(([date, count]) => ({ date, count })),
      perHour,
      perWeekday,
      outsideHours,
    },
    channels: {
      total: rooms.length,
      active: channelList.filter((c) => c.messages > 0).length,
      list: channelList,
      quiet: channelList.filter((c) => c.messages === 0).map((c) => c.name),
    },
    tasks: {
      boards: new Set(live.map((t) => t.boardId)).size,
      open: open.length,
      byStatus,
      created: tasks.filter((t) => t.createdAt >= since).length,
      done: done.length,
      unassigned: open.filter((t) => !t.assigneeId).length,
      stale: open.filter((t) => now - (t.updatedAt ?? t.createdAt) > STALE_TASK_MS).length,
      medianDaysToDone: daysToDone.length
        ? round1(daysToDone[Math.floor((daysToDone.length - 1) / 2)]!)
        : null,
    },
    calls: {
      withNotes: calls.length,
      minutes: Math.round(calls.reduce((sum, m) => sum + (m.callMinutes ?? 0), 0)),
    },
    time: {
      hours: round1(timeChannels.reduce((sum, c) => sum + c.hours, 0)),
      cost: timeChannels.some((c) => c.cost !== null)
        ? timeChannels.reduce((sum, c) => sum + (c.cost ?? 0), 0)
        : null,
      byChannel: timeChannels.sort((a, b) => b.hours - a.hours),
    },
  };
}

const nameOfChannel = (channel: Channel | undefined) =>
  !channel ? "Canal eliminado" : channel.type === "dm" ? "Mensajes directos" : channel.name;

/** Reads the tables and builds the numbers. */
export async function collectMetrics(now = Date.now()): Promise<PlatformMetrics> {
  const users: UserProfile[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.users })) {
    users.push(...((page.Items ?? []) as UserProfile[]));
  }
  const channels = await scanChannels();
  const to = dateInZone(now);
  const since =
    zonedMidnight(addDays(to, -(PLATFORM_INSIGHTS_DAYS - 1))) - PLATFORM_INSIGHTS_DAYS * DAY_MS;

  const messages: MessageFact[] = [];
  for (const channel of channels) {
    let read = 0;
    const pages = paginateQuery(
      { client: ddb },
      {
        TableName: tables.messages,
        KeyConditionExpression: "channelId = :c AND sk >= :since",
        ExpressionAttributeValues: { ":c": channel.channelId, ":since": `${since}#` },
        // Never the text, the files' names or the notes themselves.
        ProjectionExpression: "userId, createdAt, parentSk, attachments, deletedAt, aiNotes",
      },
    );
    for await (const page of pages) {
      for (const item of page.Items ?? []) {
        if (item.deletedAt || typeof item.userId !== "string") continue;
        const attachments = Array.isArray(item.attachments)
          ? (item.attachments as Array<{ contentType?: unknown }>)
          : [];
        const notes = item.aiNotes as { startedAt?: number; endedAt?: number } | undefined;
        messages.push({
          channelId: channel.channelId,
          userId: item.userId,
          createdAt: Number(item.createdAt),
          reply: typeof item.parentSk === "string",
          files: attachments.length,
          voice: attachments.some((a) => String(a.contentType ?? "").startsWith("audio/")),
          ...(notes?.startedAt &&
            notes.endedAt && { callMinutes: (notes.endedAt - notes.startedAt) / 60_000 }),
        });
      }
      read += page.Items?.length ?? 0;
      if (read >= MAX_MESSAGES_PER_CHANNEL) break;
    }
  }

  const tasks: Task[] = [];
  const taskPages = paginateScan(
    { client: ddb },
    {
      TableName: tables.tasks,
      ProjectionExpression: "boardId, #s, assigneeId, createdAt, updatedAt, doneAt, isArchived",
      ExpressionAttributeNames: { "#s": "status" },
    },
  );
  for await (const page of taskPages) tasks.push(...((page.Items ?? []) as Task[]));

  const time: TimeRow[] = [];
  const timePages = paginateScan(
    { client: ddb },
    {
      TableName: tables.timeLog,
      ProjectionExpression: "channelId, sk, userId, minutes, #d, hourlyRate",
      ExpressionAttributeNames: { "#d": "date" },
    },
  );
  for await (const page of timePages) time.push(...((page.Items ?? []) as TimeRow[]));

  return buildMetrics({ users, channels, messages, tasks, time, now });
}

// --- The model's reading of the numbers --------------------------------------------

export const PLATFORM_INSIGHTS_MAX_TOKENS = 16_000;

export const PLATFORM_INSIGHTS_SYSTEM =
  "You are the operations analyst of MindfulTech, a small software company in Ecuador that " +
  "builds products with AI for its clients and runs its own team chat, task boards, calls " +
  "and time log on one internal platform. The owner asks you how the team is working and what " +
  "to improve. You are given numbers only (counts per person, channel, day and hour; tasks by " +
  "state; hours logged), never the content of any message. Write in Spanish.";

export const PLATFORM_INSIGHTS_INSTRUCTION =
  "Read these numbers of the last period and answer as JSON. Be specific: name the people and " +
  "channels the numbers point at and quote the figures; compare with the previous period " +
  "where given. Say only what the numbers support: a count is not a judgment of anyone's " +
  "work (someone who writes little may be on calls or on a client's tools), so word findings " +
  "about people as things to check with them, never as verdicts. Where the data is too thin " +
  "to conclude (few messages, a feature nobody uses yet), say so instead of forcing a finding.\n" +
  "- summary: three or four sentences on how the team is using the platform and the one thing " +
  "that most deserves attention.\n" +
  "- wins: three to five things that are going well, one sentence each, with the figure.\n" +
  "- risks: three to five problems or risks the numbers show (work piling up, channels gone " +
  "quiet, someone carrying too much, work at odd hours, features unused, clients' channels " +
  "without activity), one or two sentences each, with the figure.\n" +
  "- recommendations: four to six concrete improvements, most valuable first. For each: " +
  "`title`, an action in at most 8 words; `why`, the numbers behind it; `how`, the first " +
  "steps to take this week, including which feature of the platform to use or change when " +
  'that applies; `impact`, "alto", "medio" or "bajo".\n' +
  "- questions: two to four questions worth asking the team that the numbers can't answer.";

export const PLATFORM_INSIGHTS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    wins: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          why: { type: "string" },
          how: { type: "string" },
          impact: { type: "string", enum: ["alto", "medio", "bajo"] },
        },
        required: ["title", "why", "how", "impact"],
        additionalProperties: false,
      },
    },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "wins", "risks", "recommendations", "questions"],
  additionalProperties: false,
} as const;

const analysisOutput = z.object({
  summary: z.string(),
  wins: z.array(z.string()),
  risks: z.array(z.string()),
  recommendations: z.array(
    z.object({ title: z.string(), why: z.string(), how: z.string(), impact: z.string() }),
  ),
  questions: z.array(z.string()),
});

export function analysisRequest(metrics: PlatformMetrics): Anthropic.MessageStreamParams {
  return {
    model: NOTES_MODEL,
    max_tokens: PLATFORM_INSIGHTS_MAX_TOKENS,
    system: PLATFORM_INSIGHTS_SYSTEM,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: PLATFORM_INSIGHTS_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `${PLATFORM_INSIGHTS_INSTRUCTION}\n\n<metrics>\n${JSON.stringify(metrics)}\n</metrics>`,
      },
    ],
  };
}

export function analysisFrom(
  response: Anthropic.Message,
): { ok: true; analysis: PlatformAnalysis } | { ok: false; error: string } {
  if (response.stop_reason === "refusal")
    return { ok: false, error: "El modelo no quiso escribir el análisis." };
  if (response.stop_reason === "max_tokens")
    return { ok: false, error: "El análisis salió demasiado largo y se cortó." };
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  try {
    const parsed = analysisOutput.parse(JSON.parse(text));
    const lines = (list: string[], max: number) =>
      list
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, max);
    return {
      ok: true,
      analysis: {
        summary: parsed.summary.trim(),
        wins: lines(parsed.wins, 6),
        risks: lines(parsed.risks, 6),
        recommendations: parsed.recommendations
          .map((r) => ({
            title: r.title.trim(),
            why: r.why.trim(),
            how: r.how.trim(),
            impact: ["alto", "medio", "bajo"].includes(r.impact) ? r.impact : "medio",
          }))
          .filter((r) => r.title && r.how)
          .slice(0, 8),
        questions: lines(parsed.questions, 5),
      },
    };
  } catch {
    return { ok: false, error: "El análisis no llegó en el formato esperado." };
  }
}

// --- Where the report is kept ----------------------------------------------------
// The news-insights table, in a partition of its own (the news only ever reads its feed's).

export const PLATFORM_FEED = "platform-insights";
const LATEST = "latest";
const STATE = "state";

export async function latestReport(): Promise<PlatformReport | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.newsInsights, Key: { feed: PLATFORM_FEED, day: LATEST } }),
  );
  if (!Item?.metrics) return null;
  const { generatedAt, metrics, analysis, analysisError } = Item as PlatformReport;
  return {
    generatedAt,
    metrics,
    ...(analysis && { analysis }),
    ...(analysisError && { analysisError }),
  };
}

export async function saveReport(report: PlatformReport): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tables.newsInsights,
      Item: { feed: PLATFORM_FEED, day: LATEST, ...report },
    }),
  );
}

export interface ReportState {
  requestedAt: number;
  done?: boolean;
  error?: string;
}

export async function reportState(): Promise<ReportState | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.newsInsights, Key: { feed: PLATFORM_FEED, day: STATE } }),
  );
  return (Item as ReportState | undefined) ?? null;
}

/** Claims the next run: one at a time, and not more often than the cooldown. */
export async function claimReport(
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const cooldown = PLATFORM_INSIGHTS_COOLDOWN_SECONDS * 1000;
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.newsInsights,
        Item: { feed: PLATFORM_FEED, day: STATE, requestedAt: now },
        ConditionExpression: "attribute_not_exists(feed) OR requestedAt <= :cutoff",
        ExpressionAttributeValues: { ":cutoff": now - cooldown },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    const last = (await reportState())?.requestedAt ?? now;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((last + cooldown - now) / 1000)) };
  }
}

export async function settleReport(requestedAt: number, error?: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tables.newsInsights,
      Item: { feed: PLATFORM_FEED, day: STATE, requestedAt, done: true, ...(error && { error }) },
    }),
  );
}
