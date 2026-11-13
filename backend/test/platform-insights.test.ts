import type { Channel, UserProfile } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  analysisFrom,
  analysisRequest,
  buildMetrics,
  insightsOwners,
  isInsightsOwner,
  type MessageFact,
} from "../src/lib/platformInsights";
import { resetMocks } from "./helpers";

// Phase 64: how the team uses the platform, in counts, for its owners only.

const NOW = Date.parse("2026-11-13T17:00:00Z"); // Friday noon in Ecuador
const at = (iso: string) => Date.parse(iso);

const users: UserProfile[] = [
  { userId: "u-ana", email: "ana@example.com", displayName: "Ana", updatedAt: 1, role: "admin" },
  { userId: "u-bob", email: "bob@example.com", displayName: "Bob", updatedAt: 1 },
  {
    userId: "u-ext",
    email: "client@example.org",
    displayName: "Cliente",
    updatedAt: 1,
    role: "guest",
  },
];
const channel = (id: string, name: string, type: Channel["type"], extra: Partial<Channel> = {}) =>
  ({
    channelId: id,
    name,
    type,
    createdBy: "u-ana",
    createdAt: 1,
    archived: false,
    ...extra,
  }) as Channel;
const channels = [
  channel("ch_general", "general", "public", { lastMessageAt: at("2026-11-12T15:00:00Z") }),
  channel("ch_client", "Cliente X", "private", { members: ["u-ana", "u-ext"] }),
  channel("dm_1", "", "dm", { members: ["u-ana", "u-bob"] }),
];
const fact = (
  channelId: string,
  userId: string,
  iso: string,
  extra: Partial<MessageFact> = {},
) => ({
  channelId,
  userId,
  createdAt: at(iso),
  reply: false,
  files: 0,
  voice: false,
  ...extra,
});

describe("the numbers", () => {
  const metrics = buildMetrics({
    users,
    channels,
    now: NOW,
    messages: [
      fact("ch_general", "u-ana", "2026-11-12T15:00:00Z"), // Thursday 10:00
      fact("ch_general", "u-ana", "2026-11-12T15:05:00Z", { reply: true }),
      fact("ch_general", "u-bob", "2026-11-11T04:00:00Z", { files: 2 }), // Tuesday 23:00: out of hours
      fact("dm_1", "u-bob", "2026-11-07T16:00:00Z", { voice: true, files: 1 }), // Saturday
      fact("dm_1", "u-ana", "2026-11-10T16:00:00Z", { callMinutes: 30 }),
      fact("ch_general", "u-ana", "2026-10-01T15:00:00Z"), // the period before
    ],
    tasks: [
      {
        boardId: "b1",
        status: "TODO",
        assigneeId: "u-bob",
        createdAt: at("2026-09-01T00:00:00Z"),
        updatedAt: at("2026-09-02T00:00:00Z"),
        doneAt: null,
        isArchived: false,
      },
      {
        boardId: "b1",
        status: "IN_PROGRESS",
        assigneeId: null,
        createdAt: at("2026-11-10T00:00:00Z"),
        updatedAt: at("2026-11-12T00:00:00Z"),
        doneAt: null,
        isArchived: false,
      },
      {
        boardId: "b2",
        status: "DONE",
        assigneeId: "u-ana",
        createdAt: at("2026-11-01T00:00:00Z"),
        updatedAt: at("2026-11-05T00:00:00Z"),
        doneAt: at("2026-11-05T00:00:00Z"),
        isArchived: false,
      },
    ],
    time: [
      { channelId: "ch_client", sk: "rate#u-bob", hourlyRate: 20 },
      {
        channelId: "ch_client",
        sk: "entry#2026-11-10#e1",
        userId: "u-bob",
        minutes: 90,
        date: "2026-11-10",
      },
      {
        channelId: "ch_client",
        sk: "entry#2026-08-01#e0",
        userId: "u-bob",
        minutes: 600,
        date: "2026-08-01",
      },
    ],
  });

  it("count the period's messages by person, channel, day and hour, in the company's time", () => {
    expect(metrics).toMatchObject({ from: "2026-10-15", to: "2026-11-13", days: 30 });
    expect(metrics.messages).toMatchObject({
      total: 5,
      previous: 1,
      inChannels: 3,
      inDirectMessages: 2,
      replies: 1,
      withFiles: 2,
      voice: 1,
      outsideHours: 2,
    });
    expect(metrics.messages.perDay).toHaveLength(30);
    expect(metrics.messages.perDay.find((d) => d.date === "2026-11-12")?.count).toBe(2);
    expect(metrics.messages.perHour[10]).toBe(2);
    expect(metrics.messages.perWeekday[3]).toBe(2); // Thursday
    expect(metrics.people).toMatchObject({ total: 3, active: 2, guests: 1 });
    expect(metrics.people.list[0]).toMatchObject({
      name: "Ana",
      messages: 3,
      activeDays: 2,
      lastActive: "2026-11-12",
      tasksDone: 1,
    });
    expect(metrics.people.list.find((p) => p.name === "Bob")).toMatchObject({
      openTasks: 1,
      hoursLogged: 1.5,
    });
  });

  it("list channels without naming direct messages, and say which went quiet", () => {
    expect(metrics.channels).toMatchObject({ total: 2, active: 1, quiet: ["Cliente X"] });
    expect(metrics.channels.list.map((c) => c.name)).toEqual(["general", "Cliente X"]);
    expect(metrics.channels.list[1]).toMatchObject({ hasExternals: true, lastMessage: null });
    expect(JSON.stringify(metrics)).not.toContain("dm_1");
    // Nobody's address is in what the model reads.
    expect(JSON.stringify(metrics)).not.toMatch(/@example/);
  });

  it("sum up tasks, calls and hours", () => {
    expect(metrics.tasks).toMatchObject({
      boards: 2,
      open: 2,
      byStatus: { TODO: 1, IN_PROGRESS: 1, DONE: 1 },
      created: 2,
      done: 1,
      unassigned: 1,
      stale: 1,
      medianDaysToDone: 4,
    });
    expect(metrics.calls).toEqual({ withNotes: 1, minutes: 30 });
    expect(metrics.time).toEqual({
      hours: 1.5,
      cost: 30,
      byChannel: [{ name: "Cliente X", hours: 1.5, cost: 30 }],
    });
  });

  it("go to the model as numbers, and come back as a checked analysis", () => {
    const request = analysisRequest(metrics);
    expect(String(request.messages[0]?.content)).toContain('"total":5');
    const reply = (text: string, stop = "end_turn") =>
      ({ stop_reason: stop, content: [{ type: "text", text }] }) as never;
    expect(
      analysisFrom(
        reply(
          JSON.stringify({
            summary: " Resumen. ",
            wins: ["Uno", " "],
            risks: ["Riesgo"],
            recommendations: [{ title: "Hacer", why: "Porque", how: "Así", impact: "enorme" }],
            questions: ["¿Qué?"],
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      analysis: {
        summary: "Resumen.",
        wins: ["Uno"],
        risks: ["Riesgo"],
        recommendations: [{ title: "Hacer", why: "Porque", how: "Así", impact: "medio" }],
        questions: ["¿Qué?"],
      },
    });
    expect(analysisFrom(reply("no es json")).ok).toBe(false);
    expect(analysisFrom(reply("{}", "max_tokens")).ok).toBe(false);
  });
});

describe("who sees it", () => {
  beforeEach(() => {
    resetMocks();
    insightsOwners.reset();
    delete process.env.INSIGHTS_OWNERS;
    delete process.env.INSIGHTS_OWNERS_PARAMETER;
  });

  it("only the addresses in the deployment's configuration; nobody until it is set", async () => {
    expect(await isInsightsOwner("owner@example.com")).toBe(false);
    insightsOwners.reset();
    process.env.INSIGHTS_OWNERS = "Owner@Example.com, second@example.com";
    expect(await isInsightsOwner("owner@example.com")).toBe(true);
    expect(await isInsightsOwner(" SECOND@example.com ")).toBe(true);
    expect(await isInsightsOwner("admin@example.com")).toBe(false);
    expect(await isInsightsOwner("")).toBe(false);
  });
});
