import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type Anthropic from "@anthropic-ai/sdk";
import { blipKey, type NewsArticle, type RadarBlip, type RadarProposal } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/radar";
import { handler as scan, useRadarModel } from "../src/handlers/radar-scan-worker";
import type { HttpEvent } from "../src/lib/http";
import { BLIP_PK, PROPOSAL_PK, SCAN_PK } from "../src/lib/radar";
import { radarScanRequest, scanPlanFrom } from "../src/lib/radarScan";
import { ALICE, BOB, ddbMock, resetMocks } from "./helpers";

vi.mock("../src/lib/news", () => ({ readAllSources: vi.fn() }));
import { readAllSources } from "../src/lib/news";

const TABLE = "slack-test-tech-radar";
const ADMIN = { userId: "user-admin", email: "admin@example.com" };
const lambdaMock = mockClient(LambdaClient);

// --- an in-memory table keyed by pk + id (the lib only does point ops and pk Queries) ---
let table: Map<string, Record<string, unknown>>;
const keyOf = (k: { pk: unknown; id: unknown }) => `${String(k.pk)}\n${String(k.id)}`;
function fakeTable() {
  table = new Map();
  ddbMock.on(PutCommand).callsFake((input) => {
    const item = input.Item as { pk: string; id: string };
    if (input.ConditionExpression?.includes("attribute_not_exists") && table.has(keyOf(item))) {
      throw new ConditionalCheckFailedException({ message: "exists", $metadata: {} });
    }
    table.set(keyOf(item), item);
    return {};
  });
  ddbMock.on(GetCommand).callsFake((input) => ({ Item: table.get(keyOf(input.Key)) }));
  ddbMock.on(DeleteCommand).callsFake((input) => {
    table.delete(keyOf(input.Key));
    return {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => ({
    Items: [...table.values()].filter((r) => r.pk === input.ExpressionAttributeValues?.[":pk"]),
  }));
  ddbMock.on(UpdateCommand).callsFake((input) => {
    const row = table.get(keyOf(input.Key));
    if (!row) {
      throw new ConditionalCheckFailedException({ message: "missing", $metadata: {} });
    }
    if (input.ConditionExpression?.includes(":pending") && row.status !== "pending") {
      throw new ConditionalCheckFailedException({ message: "not pending", $metadata: {} });
    }
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const expr = input.UpdateExpression ?? "";
    const setPart = /SET (.+?)(?: REMOVE |$)/.exec(expr)?.[1] ?? "";
    for (const assignment of setPart
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [lhs, rhs] = assignment.split("=").map((s) => s.trim());
      const key = lhs!.startsWith("#") ? names[lhs!]! : lhs!;
      row[key] = values[rhs!];
    }
    const removePart = /REMOVE (.+)$/.exec(expr)?.[1] ?? "";
    for (const name of removePart
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      delete row[names[name] ?? name];
    }
    return { Attributes: { ...row } };
  });
}
const rows = (pk: string) => [...table.values()].filter((r) => r.pk === pk);

function request(
  routeKey: string,
  body?: unknown,
  user: { userId: string; email: string } = ADMIN,
  params: Record<string, string> = {},
  groups = user === ADMIN ? "[admins]" : "",
): HttpEvent {
  return {
    routeKey,
    pathParameters: params,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: user.userId, email: user.email, "cognito:groups": groups } },
      },
    },
  } as unknown as HttpEvent;
}
async function call(routeKey: string, body?: unknown, user = ADMIN, params = {}, groups?: string) {
  const r = (await handler(request(routeKey, body, user, params, groups))) as {
    statusCode: number;
    body?: string;
  };
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
}

beforeEach(() => {
  resetMocks();
  process.env.TECH_RADAR_TABLE = TABLE;
  process.env.RADAR_WORKER_FUNCTION = "slack-test-radar-scan-worker";
  process.env.RADAR_DISCOVERY_FUNCTION = "slack-test-radar-discovery-engine";
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
  fakeTable();
});

describe("radar endpoints", () => {
  it("adds a technology (admins only), with an id derived from its name", async () => {
    const created = await call("POST /radar/blips", {
      name: "LangGraph",
      quadrant: "Frameworks",
      ring: "Trial",
      description: "Agent graphs on LangChain.",
      link: "https://langchain-ai.github.io/langgraph/",
    });
    expect(created.status).toBe(201);
    expect(created.body.blip).toMatchObject({
      id: "langgraph",
      ring: "Trial",
      previousRing: null,
      updatedBy: ADMIN.userId,
    });
    // Same technology, spelled differently: refused.
    expect(
      (
        await call("POST /radar/blips", {
          name: "lang-graph",
          quadrant: "Frameworks",
          ring: "Assess",
        })
      ).status,
    ).toBe(409);
    // A member reads, but can't write; a guest sees nothing.
    expect(
      (
        await call(
          "POST /radar/blips",
          { name: "X", quadrant: "Models", ring: "Hold" },
          ALICE,
          {},
          "",
        )
      ).status,
    ).toBe(403);
    const list = await call("GET /radar", undefined, ALICE, {}, "");
    expect(list.status).toBe(200);
    expect(list.body.blips.map((b: RadarBlip) => b.name)).toEqual(["LangGraph"]);
    expect((await call("GET /radar", undefined, BOB, {}, "[guests]")).status).toBe(403);
  });

  it("a new ring records the move (previousRing, movedAt); other fields don't", async () => {
    await call("POST /radar/blips", { name: "Claude Code", quadrant: "DevTools", ring: "Trial" });
    const edited = await call("PUT /radar/blips/{id}", { description: "Daily driver." }, ADMIN, {
      id: "claudecode",
    });
    expect(edited.body.blip).toMatchObject({ description: "Daily driver.", previousRing: null });
    expect(edited.body.blip.movedAt).toBeUndefined();
    const moved = await call("PUT /radar/blips/{id}", { ring: "Adopt" }, ADMIN, {
      id: "claudecode",
    });
    expect(moved.body.blip).toMatchObject({ ring: "Adopt", previousRing: "Trial" });
    expect(typeof moved.body.blip.movedAt).toBe("number");
    expect(
      (await call("PUT /radar/blips/{id}", { ring: "Hold" }, ADMIN, { id: "nope" })).status,
    ).toBe(404);
    expect(
      (await call("DELETE /radar/blips/{id}", undefined, ADMIN, { id: "claudecode" })).status,
    ).toBe(200);
    expect(rows(BLIP_PK)).toHaveLength(0);
  });

  it("applying a move proposal moves the blip; applying an add creates it; dismissing just closes it", async () => {
    await call("POST /radar/blips", { name: "LangChain", quadrant: "Frameworks", ring: "Trial" });
    const move: RadarProposal = {
      id: "p1",
      kind: "move",
      blipId: "langchain",
      name: "LangChain",
      quadrant: "Frameworks",
      ring: "Hold",
      fromRing: "Trial",
      rationale: "Deprecated APIs.",
      status: "pending",
      createdAt: 1,
    };
    const add: RadarProposal = {
      id: "p2",
      kind: "add",
      name: "NewTool",
      quadrant: "DevTools",
      ring: "Assess",
      rationale: "Just released.",
      description: "A tool.",
      status: "pending",
      createdAt: 2,
    };
    table.set(keyOf({ pk: PROPOSAL_PK, id: "p1" }), { pk: PROPOSAL_PK, ...move });
    table.set(keyOf({ pk: PROPOSAL_PK, id: "p2" }), { pk: PROPOSAL_PK, ...add });

    const applied = await call("POST /radar/proposals/{id}/apply", undefined, ADMIN, { id: "p1" });
    expect(applied.status).toBe(200);
    expect(applied.body.blip).toMatchObject({
      ring: "Hold",
      previousRing: "Trial",
      updatedBy: ADMIN.userId,
    });
    expect(applied.body.proposal).toMatchObject({ status: "applied", resolvedBy: ADMIN.userId });

    const dismissed = await call("POST /radar/proposals/{id}/dismiss", undefined, ADMIN, {
      id: "p2",
    });
    expect(dismissed.body.proposal.status).toBe("dismissed");
    expect(rows(BLIP_PK).map((b) => b.id)).toEqual(["langchain"]);
    // Already decided: gone.
    expect(
      (await call("POST /radar/proposals/{id}/apply", undefined, ADMIN, { id: "p2" })).status,
    ).toBe(404);
    // Pending proposals don't show once resolved.
    expect((await call("GET /radar")).body.proposals).toEqual([]);
  });

  it("an admin's Scan now starts both scanners asynchronously", async () => {
    expect((await call("POST /radar/scan")).status).toBe(202);
    const invokes = lambdaMock.commandCalls(InvokeCommand).map((c) => c.args[0].input);
    expect(invokes).toEqual([
      { FunctionName: "slack-test-radar-scan-worker", InvocationType: "Event" },
      { FunctionName: "slack-test-radar-discovery-engine", InvocationType: "Event" },
    ]);
    expect((await call("POST /radar/scan", undefined, ALICE, {}, "")).status).toBe(403);
  });

  it("the snapshot says when each scanner last ran", async () => {
    table.set(keyOf({ pk: SCAN_PK, id: "last" }), { pk: SCAN_PK, id: "last", at: 10 });
    table.set(keyOf({ pk: SCAN_PK, id: "discovery" }), { pk: SCAN_PK, id: "discovery", at: 20 });
    expect((await call("GET /radar")).body).toMatchObject({ lastScanAt: 10, lastDiscoveryAt: 20 });
  });

  it("accepting a new technology adds it to Assess with its link and facts", async () => {
    const add: RadarProposal = {
      id: "p3",
      kind: "add",
      name: "Zeta-9",
      quadrant: "Models",
      ring: "Assess",
      rationale: "New.",
      description: "A model.",
      sourceLink: "https://a/1",
      meta: { modelId: "acme/zeta-9" },
      origin: "news-scan",
      status: "pending",
      createdAt: 3,
    };
    table.set(keyOf({ pk: PROPOSAL_PK, id: "p3" }), { pk: PROPOSAL_PK, ...add });
    const accepted = await call("POST /radar/proposals/{id}/apply", undefined, ADMIN, { id: "p3" });
    expect(accepted.body.blip).toMatchObject({
      id: "zeta9",
      ring: "Assess",
      description: "A model.",
      link: "https://a/1",
      meta: { modelId: "acme/zeta-9" },
      updatedBy: ADMIN.userId,
    });
  });
});

// --- the scanner -------------------------------------------------------------------

const article = (title: string, link: string): NewsArticle => ({
  title,
  link,
  snippet: "",
  pubDate: "2026-11-10T08:00:00Z",
  imageUrl: null,
  sourceName: "The Verge",
});
const blip = (
  name: string,
  ring: RadarBlip["ring"],
  quadrant: RadarBlip["quadrant"] = "Frameworks",
): RadarBlip => ({
  id: blipKey(name),
  name,
  quadrant,
  ring,
  description: "",
  previousRing: null,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: "u",
});
const answer = (json: unknown): Anthropic.Message =>
  ({
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Message;

describe("radar scan plan", () => {
  const articles = [
    article("Acme releases Zeta-9", "https://a/1"),
    article("LangChain 1.0", "https://a/2"),
  ];
  const blips = [blip("LangChain", "Trial"), blip("Claude Code", "Adopt", "DevTools")];

  it("asks Haiku with the radar and the stories, held to the JSON schema", () => {
    const req = radarScanRequest(articles, blips, "2026-11-10");
    expect(req.model).toBe("us.anthropic.claude-haiku-5-5");
    expect(req.output_config?.format).toMatchObject({ type: "json_schema" });
    const prompt = String(req.messages[0]?.content);
    expect(prompt).toContain("id=langchain | LangChain | Frameworks | Trial");
    expect(prompt).toContain("Acme releases Zeta-9");
  });

  it("keeps new technologies and real moves; drops duplicates, unknown blips and no-op moves", () => {
    const outcome = scanPlanFrom(
      answer({
        adds: [
          {
            name: "Zeta-9",
            quadrant: "Models",
            description: "A model.",
            rationale: "New.",
            story: 1,
            modelId: "acme/zeta-9",
          },
          {
            name: "Lang Chain",
            quadrant: "Frameworks",
            description: "dup",
            rationale: "",
            story: 2,
            modelId: "",
          },
          {
            name: "Zeta 9",
            quadrant: "Models",
            description: "dup",
            rationale: "",
            story: 1,
            modelId: "",
          },
        ],
        moves: [
          { id: "langchain", ring: "Hold", rationale: "1.0 breaks APIs.", story: 2 },
          { id: "langchain", ring: "Trial", rationale: "no-op", story: 2 },
          { id: "ghost", ring: "Hold", rationale: "unknown", story: 2 },
        ],
      }),
      articles,
      blips,
      [],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.adds.map((a) => [a.name, a.modelId, a.source?.link])).toEqual([
      ["Zeta-9", "acme/zeta-9", "https://a/1"],
    ]);
    expect(outcome.plan.moves.map((m) => [m.blip.id, m.ring])).toEqual([["langchain", "Hold"]]);
  });

  it("doesn't propose again what is pending or was rejected, by a similar name", () => {
    const rejected: RadarProposal = {
      id: "r",
      kind: "add",
      name: "Zeta-9",
      quadrant: "Models",
      ring: "Assess",
      rationale: "",
      status: "dismissed",
      createdAt: 1,
    };
    const outcome = scanPlanFrom(
      answer({
        adds: [
          {
            name: "Zeta 9",
            quadrant: "Models",
            description: "",
            rationale: "",
            story: 1,
            modelId: "",
          },
          {
            name: "LangChain v1.0",
            quadrant: "Frameworks",
            description: "",
            rationale: "",
            story: 2,
            modelId: "",
          },
        ],
        moves: [],
      }),
      articles,
      blips,
      [rejected],
    );
    expect(outcome).toEqual({ ok: true, plan: { adds: [], moves: [] } });
  });

  it("doesn't repeat a pending proposal and reports an unusable answer", () => {
    const pending: RadarProposal = {
      id: "p",
      kind: "move",
      blipId: "langchain",
      name: "LangChain",
      quadrant: "Frameworks",
      ring: "Hold",
      rationale: "",
      status: "pending",
      createdAt: 1,
    };
    const outcome = scanPlanFrom(
      answer({
        adds: [],
        moves: [{ id: "langchain", ring: "Hold", rationale: "again", story: 2 }],
      }),
      articles,
      blips,
      [pending],
    );
    expect(outcome).toEqual({ ok: true, plan: { adds: [], moves: [] } });
    expect(scanPlanFrom(answer("nope"), articles, blips, [])).toMatchObject({ ok: false });
  });

  it("the worker files new technologies (for Assess) and moves as pending proposals", async () => {
    vi.mocked(readAllSources).mockResolvedValue({
      articles,
      sources: [],
      failed: [],
      discarded: [],
    } as never);
    for (const b of blips) table.set(keyOf({ pk: BLIP_PK, id: b.id }), { pk: BLIP_PK, ...b });
    const create = vi.fn().mockResolvedValue(
      answer({
        adds: [
          {
            name: "Zeta-9",
            quadrant: "Models",
            description: "A model.",
            rationale: "New.",
            story: 1,
            modelId: "acme/zeta-9",
          },
        ],
        moves: [{ id: "langchain", ring: "Hold", rationale: "1.0 breaks APIs.", story: 2 }],
      }),
    );
    useRadarModel({ create });
    const run = await scan();
    expect(run).toMatchObject({ added: ["Zeta-9"], proposed: ["LangChain → Hold"], articles: 2 });
    // Nothing reaches the radar until an admin accepts it.
    expect(table.get(keyOf({ pk: BLIP_PK, id: "zeta9" }))).toBeUndefined();
    const proposals = rows(PROPOSAL_PK);
    expect(proposals.map((p) => [p.kind, p.status, p.ring, p.origin])).toEqual(
      expect.arrayContaining([
        ["add", "pending", "Assess", "news-scan"],
        ["move", "pending", "Hold", "news-scan"],
      ]),
    );
    expect(proposals.find((p) => p.kind === "add")).toMatchObject({
      sourceLink: "https://a/1",
      meta: { modelId: "acme/zeta-9" },
    });
    expect(table.get(keyOf({ pk: SCAN_PK, id: "last" }))).toMatchObject({ added: 1, proposed: 1 });
    // A retry (same answer) files no duplicate proposal.
    await scan();
    expect(rows(BLIP_PK)).toHaveLength(2);
    expect(rows(PROPOSAL_PK)).toHaveLength(2);
    useRadarModel(null);
  });
});
