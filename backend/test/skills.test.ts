import { inflateRawSync } from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { parseFrontmatter, type Skill, type SkillSummary } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, useGithubFetch, useSkillModel } from "../src/handlers/skills";
import { NOTES_MODEL } from "../src/lib/callNotes";
import type { HttpEvent } from "../src/lib/http";
import { githubToken } from "../src/lib/skillGithub";
import { SKILL_GENERATOR_SYSTEM } from "../src/lib/skillGenerate";
import { githubSkillId, resetSeeded, seedSkill } from "../src/lib/skills";
import { crc32 } from "../src/lib/zip";
import { ALICE, BOB, ddbMock, resetMocks } from "./helpers";

const SKILLS = "slack-test-skills";
const ADMIN = { userId: "user-admin", email: "admin@example.com" };
const SEED_ID = githubSkillId(
  "https://github.com/cloudflare/security-audit-skill",
  "skills/security-audit",
);

// --- An in-memory skills table behind the DynamoDB mock ---------------------------

type Row = Record<string, unknown> & { skillId: string; sk: string };
let table: Map<string, Row>;
const keyOf = (k: { skillId: unknown; sk: unknown }) => `${String(k.skillId)}\n${String(k.sk)}`;
const rows = () => [...table.values()];

function fakeTable() {
  table = new Map();
  ddbMock.on(PutCommand, { TableName: SKILLS }).callsFake(({ Item }: { Item: Row }) => {
    table.set(keyOf(Item), structuredClone(Item));
    return {};
  });
  ddbMock.on(GetCommand, { TableName: SKILLS }).callsFake(({ Key }: { Key: Row }) => ({
    Item: table.get(keyOf(Key)),
  }));
  ddbMock
    .on(QueryCommand, { TableName: SKILLS })
    .callsFake(
      ({
        ExpressionAttributeValues: v,
      }: {
        ExpressionAttributeValues: Record<string, string>;
      }) => ({
        Items: rows().filter(
          (r) => r.skillId === v[":id"] && (!v[":f"] || r.sk.startsWith(v[":f"])),
        ),
      }),
    );
  ddbMock.on(ScanCommand, { TableName: SKILLS }).callsFake(() => ({
    Items: rows().filter((r) => r.sk === "meta"),
  }));
  ddbMock
    .on(BatchWriteCommand)
    .callsFake(
      ({
        RequestItems,
      }: {
        RequestItems: Record<string, Array<Record<string, { Item?: Row; Key?: Row }>>>;
      }) => {
        for (const req of RequestItems[SKILLS] ?? []) {
          if (req.PutRequest)
            table.set(keyOf(req.PutRequest.Item!), structuredClone(req.PutRequest.Item!));
          if (req.DeleteRequest) table.delete(keyOf(req.DeleteRequest.Key!));
        }
        return { UnprocessedItems: {} };
      },
    );
  ddbMock
    .on(GetCommand, { TableName: "slack-test-users" })
    .resolves({ Item: { displayName: "Alice Andrade" } });
}

// --- Requests ---------------------------------------------------------------------

type Caller = { userId: string; email: string };
function request(
  routeKey: string,
  opts: { body?: unknown; id?: string; user?: Caller; groups?: string } = {},
) {
  const user = opts.user ?? ALICE;
  return {
    version: "2.0",
    routeKey,
    rawPath: "/skills",
    headers: {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    pathParameters: opts.id ? { id: opts.id } : undefined,
    requestContext: {
      http: { method: routeKey.split(" ")[0] },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(opts.groups && { "cognito:groups": `[${opts.groups}]` }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
}
async function call(routeKey: string, opts: Parameters<typeof request>[1] = {}) {
  const result = (await handler(request(routeKey, opts))) as {
    statusCode: number;
    body: string;
    headers?: Record<string, string>;
    isBase64Encoded?: boolean;
  };
  const isJson = !result.isBase64Encoded && result.body;
  return {
    ...result,
    status: result.statusCode,
    json: isJson ? JSON.parse(result.body) : undefined,
  };
}
const asAdmin = { user: ADMIN, groups: "admins" };

beforeEach(() => {
  resetMocks();
  resetSeeded();
  fakeTable();
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  useGithubFetch(null);
  useSkillModel(null);
  githubToken.reset();
  delete process.env.GITHUB_TOKEN;
});

// --- The catalog ------------------------------------------------------------------

describe("the catalog", () => {
  it("starts with Cloudflare's security-audit skill, added once", async () => {
    const first = await call("GET /skills");
    expect(first.status).toBe(200);
    const [skill] = first.json.skills as SkillSummary[];
    expect(skill).toMatchObject({
      id: SEED_ID,
      slug: "security-audit",
      sourceType: "github",
      category: "Security",
      repoUrl: "https://github.com/cloudflare/security-audit-skill",
      repoPath: "skills/security-audit",
      authorId: "system",
    });
    expect(skill!.description).toMatch(/^Security guidance and vulnerability review/);
    // Its 19 companion files and the licence; the list carries sizes, not contents.
    expect(skill!.files.map((f) => f.path)).toContain("HUNTING.md");
    expect(skill!.files.map((f) => f.path)).toContain("LICENSE");
    expect(skill!.files).toHaveLength(20);
    expect(JSON.stringify(first.json)).not.toContain("Find vulnerabilities that violate");

    const writes = ddbMock.commandCalls(PutCommand).length;
    resetSeeded(); // a new container
    await call("GET /skills");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(writes); // the marker says it's done
  });

  it("doesn't bring the built-in skill back once an admin removed it", async () => {
    await call("GET /skills");
    expect((await call("DELETE /skills/{id}", { id: SEED_ID })).status).toBe(403); // a member
    expect((await call("DELETE /skills/{id}", { id: SEED_ID, ...asAdmin })).status).toBe(200);
    resetSeeded();
    expect((await call("GET /skills")).json.skills).toEqual([]);
  });

  it("returns a skill in full, with its files in order", async () => {
    await call("GET /skills");
    const { status, json } = await call("GET /skills/{id}", { id: SEED_ID });
    expect(status).toBe(200);
    const skill = json.skill as Skill;
    expect(parseFrontmatter(skill.skillMd)!.data.name).toBe("security-audit");
    expect(skill.files.map((f) => f.path)).toEqual(seedSkill(0).files.map((f) => f.path));
    expect(skill.files.find((f) => f.path === "LICENSE")!.content).toMatch(/^MIT License/);
    expect((await call("GET /skills/{id}", { id: "sk_nope" })).status).toBe(404);
  });

  it("is for members only", async () => {
    expect((await call("GET /skills", { groups: "guests" })).status).toBe(403);
  });
});

// --- Team skills -------------------------------------------------------------------

describe("team skills", () => {
  const md = `---\nname: CDK IAM Audit\ndescription: Audits AWS CDK IAM policies for wildcards. Use when reviewing CDK stacks.\n---\n\n# CDK IAM audit\n\n1. Read every PolicyStatement.\n`;

  it("takes name and description from SKILL.md, fixing the name to Claude Code's form", async () => {
    const { status, json } = await call("POST /skills", {
      body: {
        category: "Security",
        skillMd: md,
        files: [{ path: "scripts/scan.sh", content: "echo scan" }],
      },
    });
    expect(status).toBe(201);
    const skill = json.skill as Skill;
    expect(skill).toMatchObject({
      slug: "cdk-iam-audit",
      name: "cdk-iam-audit",
      description: "Audits AWS CDK IAM policies for wildcards. Use when reviewing CDK stacks.",
      sourceType: "team",
      authorId: ALICE.userId,
      authorName: "Alice Andrade",
    });
    expect(skill.id).toMatch(/^sk_/);
    expect(skill.skillMd.startsWith("---\nname: cdk-iam-audit\ndescription: Audits")).toBe(true);
    // Stored: the metadata and one row per file.
    expect(table.get(`${skill.id}\nfile#scripts/scan.sh`)?.content).toBe("echo scan");
  });

  it("writes the frontmatter for a name and description alone", async () => {
    const { json } = await call("POST /skills", {
      body: {
        category: "Workflow",
        name: "Release Notes",
        description: "Drafts release notes from merged PRs.",
      },
    });
    expect(parseFrontmatter(json.skill.skillMd)!.data).toEqual({
      name: "release-notes",
      description: "Drafts release notes from merged PRs.",
    });
  });

  it("refuses a second skill with the same name, and edits by anyone but its author or an admin", async () => {
    const { json } = await call("POST /skills", { body: { category: "Security", skillMd: md } });
    const id = json.skill.id as string;
    expect(
      (await call("POST /skills", { body: { category: "Security", skillMd: md } })).status,
    ).toBe(409);

    const edit = { id, category: "DevOps", skillMd: md.replace("1. Read", "1. List") };
    expect((await call("POST /skills", { body: edit, user: BOB })).status).toBe(403);
    const mine = await call("POST /skills", { body: edit });
    expect(mine.status).toBe(200);
    expect(mine.json.skill).toMatchObject({ id, category: "DevOps", createdAt: 1_800_000_000_000 });
    expect((await call("POST /skills", { body: edit, ...asAdmin })).status).toBe(200);

    // Files it no longer has go away.
    await call("POST /skills", { body: { ...edit, files: [{ path: "a.md", content: "a" }] } });
    await call("POST /skills", { body: { ...edit, files: [] } });
    expect(
      rows()
        .filter((r) => r.skillId === id)
        .map((r) => r.sk),
    ).toEqual(["meta"]);

    expect((await call("DELETE /skills/{id}", { id, user: BOB })).status).toBe(403);
    expect((await call("DELETE /skills/{id}", { id })).status).toBe(200);
    expect(rows().filter((r) => r.skillId === id)).toEqual([]);
  });

  it("refuses bodies without a usable name or description, and unsafe file paths", async () => {
    expect(
      (await call("POST /skills", { body: { category: "Security", skillMd: "# No frontmatter" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST /skills", {
          body: { category: "Security", skillMd: md, files: [{ path: "../x", content: "" }] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST /skills", {
          body: { id: "sk_missing", category: "Security", skillMd: md },
        })
      ).status,
    ).toBe(404);
  });
});

// --- GitHub ------------------------------------------------------------------------

const COMMIT = "a".repeat(40);
function githubFetch(routes: Record<string, string | number>, seen: string[] = []) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push(`${u} ${new Headers(init?.headers).get("authorization") ?? ""}`.trim());
    const answer = routes[u];
    if (answer === undefined) return new Response("Not Found", { status: 404 });
    if (typeof answer === "number") return new Response("nope", { status: answer });
    return new Response(answer, { status: 200 });
  }) as unknown as typeof fetch;
}
const API = "https://api.github.com/repos/acme/skills";
const RAW = `https://raw.githubusercontent.com/acme/skills/${COMMIT}`;
const tree = (paths: Array<[string, number]>) =>
  JSON.stringify({ tree: paths.map(([path, size]) => ({ path, type: "blob", size })) });
const ACME_MD = `---\nname: k8s-review\ndescription: Reviews Kubernetes manifests for risky defaults. Use for k8s YAML reviews.\n---\n\n# Review\n`;

function acmeRepo(extra: Record<string, string | number> = {}) {
  return {
    [`${API}/commits/HEAD`]: COMMIT,
    [`${API}/git/trees/${COMMIT}?recursive=1`]: tree([
      ["README.md", 10],
      ["LICENSE", 20],
      ["skills/k8s-review/SKILL.md", 100],
      ["skills/k8s-review/checks/pods.md", 5],
      ["skills/k8s-review/logo.png", 4],
      ["skills/k8s-review/.hidden", 1],
    ]),
    [`${RAW}/skills/k8s-review/SKILL.md`]: ACME_MD,
    [`${RAW}/skills/k8s-review/checks/pods.md`]: "# Pods\n",
    [`${RAW}/skills/k8s-review/logo.png`]: "\u0089PNG\u0000\u0001",
    [`${RAW}/LICENSE`]: "MIT License\n",
    ...extra,
  };
}

describe("importing from GitHub", () => {
  it("finds the repository's only skill, takes its files and licence, and saves it", async () => {
    useGithubFetch(githubFetch(acmeRepo()));
    const { status, json } = await call("POST /skills/import-github", {
      body: { repoUrl: "https://github.com/acme/skills" },
    });
    expect(status).toBe(201);
    expect(json.skill).toMatchObject({
      id: githubSkillId("https://github.com/acme/skills", "skills/k8s-review"),
      slug: "k8s-review",
      description: "Reviews Kubernetes manifests for risky defaults. Use for k8s YAML reviews.",
      sourceType: "github",
      category: "DevOps",
      repoUrl: "https://github.com/acme/skills",
      repoPath: "skills/k8s-review",
      repoCommit: COMMIT,
      authorName: "Alice Andrade",
    });
    expect((json.skill as Skill).files.map((f) => f.path)).toEqual(["checks/pods.md", "LICENSE"]);
    expect(json.skipped).toEqual(["logo.png"]); // binary
    expect(table.has(`${json.skill.id}\nmeta`)).toBe(true);
  });

  it("previews without saving; a second import syncs the same skill", async () => {
    useGithubFetch(githubFetch(acmeRepo()));
    const preview = await call("POST /skills/import-github", {
      body: { repoUrl: "acme/skills", preview: true },
    });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ exists: false, skill: { slug: "k8s-review" } });
    expect(rows()).toEqual([]);

    const first = await call("POST /skills/import-github", {
      body: { repoUrl: "acme/skills", category: "Security" },
    });
    vi.setSystemTime(1_800_000_100_000);
    useGithubFetch(
      githubFetch(
        acmeRepo({
          [`${RAW}/skills/k8s-review/SKILL.md`]: ACME_MD.replace("# Review", "# Review v2"),
        }),
      ),
    );
    const sync = await call("POST /skills/import-github", {
      body: { repoUrl: "acme/skills" },
      user: BOB,
    });
    expect(sync.status).toBe(200);
    expect(sync.json.skill).toMatchObject({
      id: first.json.skill.id,
      category: "Security", // kept
      authorId: ALICE.userId, // whoever imported it first
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_100_000,
    });
    expect(sync.json.skill.skillMd).toContain("# Review v2");
  });

  it("reads the folder and branch a URL names, and asks which skill when there are several", async () => {
    const seen: string[] = [];
    useGithubFetch(
      githubFetch(
        {
          [`${API}/commits/v2`]: COMMIT,
          [`${API}/git/trees/${COMMIT}?recursive=1`]: tree([
            ["a/SKILL.md", 1],
            ["b/SKILL.md", 1],
          ]),
          [`${RAW}/b/SKILL.md`]: "---\nname: b\ndescription: B skill.\n---\nB\n",
        },
        seen,
      ),
    );
    const picked = await call("POST /skills/import-github", {
      body: { repoUrl: "https://github.com/acme/skills/tree/v2/b", preview: true },
    });
    expect(picked.json.skill).toMatchObject({ slug: "b", repoPath: "b", repoRef: "v2" });

    // A sync of a skill read from the default branch names HEAD: not a branch to keep.
    useGithubFetch(
      githubFetch({
        [`${API}/commits/HEAD`]: COMMIT,
        [`${API}/git/trees/${COMMIT}?recursive=1`]: tree([["b/SKILL.md", 1]]),
        [`${RAW}/b/SKILL.md`]: "---\nname: b\ndescription: B skill.\n---\nB\n",
      }),
    );
    const synced = await call("POST /skills/import-github", {
      body: { repoUrl: "https://github.com/acme/skills/tree/HEAD/b", preview: true },
    });
    expect(synced.json.skill.repoPath).toBe("b");
    expect(synced.json.skill).not.toHaveProperty("repoRef");

    useGithubFetch(
      githubFetch({
        [`${API}/commits/HEAD`]: COMMIT,
        [`${API}/git/trees/${COMMIT}?recursive=1`]: tree([
          ["a/SKILL.md", 1],
          ["b/SKILL.md", 1],
        ]),
      }),
    );
    const several = await call("POST /skills/import-github", { body: { repoUrl: "acme/skills" } });
    expect(several.status).toBe(422);
    expect(several.json.message).toMatch(/2 skills \(a, b\)/);
  });

  it("explains GitHub's answers: not found, rate limited, not a GitHub URL", async () => {
    useGithubFetch(githubFetch({}));
    expect(
      (await call("POST /skills/import-github", { body: { repoUrl: "acme/missing" } })).status,
    ).toBe(404);
    useGithubFetch(githubFetch({ [`${API}/commits/HEAD`]: 403 }));
    const limited = await call("POST /skills/import-github", { body: { repoUrl: "acme/skills" } });
    expect(limited.status).toBe(503);
    expect(limited.json.message).toMatch(/limiting/);
    expect(
      (await call("POST /skills/import-github", { body: { repoUrl: "https://gitlab.com/a/b" } }))
        .status,
    ).toBe(400);
  });

  it("sends the token to the API (never to raw files) when one is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const seen: string[] = [];
    useGithubFetch(githubFetch(acmeRepo(), seen));
    await call("POST /skills/import-github", { body: { repoUrl: "acme/skills", preview: true } });
    expect(
      seen
        .filter((s) => s.startsWith("https://api.github.com"))
        .every((s) => s.endsWith("Bearer ghp_test")),
    ).toBe(true);
    expect(seen.filter((s) => s.startsWith("https://raw.")).some((s) => s.includes("Bearer"))).toBe(
      false,
    );
  });

  it("refuses a GitHub skill whose name another skill already has", async () => {
    await call("POST /skills", {
      body: { category: "DevOps", name: "k8s-review", description: "Ours." },
    });
    useGithubFetch(githubFetch(acmeRepo()));
    expect(
      (await call("POST /skills/import-github", { body: { repoUrl: "acme/skills" } })).status,
    ).toBe(409);
  });
});

// --- Generating ------------------------------------------------------------------

describe("generating a skill with Claude Haiku 5.5", () => {
  const answer = (text: string, stop_reason: Anthropic.Message["stop_reason"] = "end_turn") =>
    ({
      id: "msg",
      type: "message",
      role: "assistant",
      model: NOTES_MODEL,
      content: [{ type: "text", text }],
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 900 },
    }) as unknown as Anthropic.Message;

  it("returns a SKILL.md with valid frontmatter, normalized; nothing is saved", async () => {
    const create = vi.fn(async (_params: unknown) =>
      answer(
        "Here it is:\n<skill_md>\n---\nname: AWS CDK IAM Audit\ndescription: >\n  Audits IAM in CDK stacks.\n  Use when reviewing CDK.\n---\n\n# Steps\n1. Find PolicyStatements.\n</skill_md>",
      ),
    );
    useSkillModel({ create });
    const { status, json } = await call("POST /skills/generate", {
      body: { prompt: "Create a skill to audit AWS CDK IAM permissions" },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      name: "aws-cdk-iam-audit",
      description: "Audits IAM in CDK stacks. Use when reviewing CDK.",
    });
    expect(parseFrontmatter(json.skillMd)!.data.name).toBe("aws-cdk-iam-audit");
    expect(json.skillMd).toContain("1. Find PolicyStatements.");
    const params = create.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({ model: NOTES_MODEL, system: SKILL_GENERATOR_SYSTEM });
    expect(JSON.stringify(params.messages)).toContain(
      "<idea>\\nCreate a skill to audit AWS CDK IAM permissions\\n</idea>",
    );
    expect(rows()).toEqual([]);
  });

  it("fails clearly: no frontmatter, cut off, refused, busy", async () => {
    useSkillModel({ create: vi.fn(async () => answer("<skill_md># No frontmatter</skill_md>")) });
    expect(
      (await call("POST /skills/generate", { body: { prompt: "a skill for something" } })).status,
    ).toBe(502);
    useSkillModel({ create: vi.fn(async () => answer("---", "max_tokens")) });
    expect(
      (await call("POST /skills/generate", { body: { prompt: "a skill for something" } })).json
        .message,
    ).toMatch(/too long/);
    useSkillModel({
      create: vi.fn(async () => {
        throw new Anthropic.RateLimitError(429, {}, "slow", new Headers());
      }),
    });
    expect(
      (await call("POST /skills/generate", { body: { prompt: "a skill for something" } })).status,
    ).toBe(503);
    expect((await call("POST /skills/generate", { body: { prompt: "short" } })).status).toBe(400);
  });
});

// --- Downloading ---------------------------------------------------------------------

/** The entries of a zip, read back from its central directory. */
function unzip(zip: Buffer): Record<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(dataAt, dataAt + size));
    expect(crc32(data)).toBe(zip.readUInt32LE(at + 16));
    files[name] = data.toString("utf8");
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

describe("downloading", () => {
  it("zips <slug>/SKILL.md and its files, ready for .claude/skills/", async () => {
    await call("GET /skills");
    const result = await call("GET /skills/{id}/download", { id: SEED_ID });
    expect(result.status).toBe(200);
    expect(result.isBase64Encoded).toBe(true);
    expect(result.headers).toMatchObject({
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="security-audit.zip"',
    });
    const files = unzip(Buffer.from(result.body, "base64"));
    expect(Object.keys(files)).toHaveLength(21);
    expect(files["security-audit/SKILL.md"]).toBe(seedSkill(0).skillMd);
    expect(files["security-audit/validate-findings.cjs"]).toContain("findings");
    expect(Object.keys(files).every((p) => p.startsWith("security-audit/"))).toBe(true);
    expect((await call("GET /skills/{id}/download", { id: "sk_none" })).status).toBe(404);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});
