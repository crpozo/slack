import { createHash } from "node:crypto";
import { GetCommand, paginateQuery, paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  parseFrontmatter,
  toSkillSlug,
  type Skill,
  type SkillCategory,
  type SkillFile,
  type SkillSummary,
} from "@mindfultech/shared";
import { batchDelete, batchPut, ddb, tables } from "./ddb";
import { log } from "./logger";
import seed from "./skillSeeds/cloudflare-security-audit.json";

// ---------------------------------------------------------------------------
// AI Skills (Phase 44): the catalog in DynamoDB. One partition per skill:
//
//   meta              everything but the companion files' contents (SKILL.md
//                     included), what the catalog lists
//   file#<path>       one companion file (a large skill stays far from
//                     DynamoDB's 400 KB item limit: Cloudflare's is 326 KB)
//
// and `_catalog` / `seed#<id>` once a built-in skill was added, so one an
// admin deleted isn't added back.
// ---------------------------------------------------------------------------

const META = "meta";
const FILE_PREFIX = "file#";
const CATALOG = "_catalog";

type MetaRow = Omit<Skill, "files" | "id"> & {
  skillId: string;
  sk: typeof META;
  files: SkillSummary["files"];
};

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** A GitHub skill's id: the same repository folder is always the same skill (a re-import updates it). */
export function githubSkillId(repoUrl: string, repoPath: string): string {
  const key = `${repoUrl.replace(/^https:\/\/github\.com\//i, "")}/${repoPath}`.toLowerCase();
  return `gh_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

/** A metadata row as the catalog lists it: its id, without the key or SKILL.md. */
function toSummary(row: Record<string, unknown>): SkillSummary {
  const summary = { ...row, id: String(row.skillId) } as Record<string, unknown>;
  for (const key of ["skillId", "sk", "skillMd"]) delete summary[key];
  return summary as unknown as SkillSummary;
}

/** Every skill, without contents, by name. */
export async function listSkills(): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: tables.skills,
      FilterExpression: "sk = :meta",
      ExpressionAttributeValues: { ":meta": META },
    },
  )) {
    for (const item of page.Items ?? []) skills.push(toSummary(item));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** One skill with its contents, or `null`. */
export async function getSkill(id: string): Promise<Skill | null> {
  let meta: Record<string, unknown> | undefined;
  const files: SkillFile[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.skills,
      KeyConditionExpression: "skillId = :id",
      ExpressionAttributeValues: { ":id": id },
    },
  )) {
    for (const item of page.Items ?? []) {
      if (item.sk === META) meta = item;
      else if (typeof item.sk === "string" && item.sk.startsWith(FILE_PREFIX)) {
        files.push({ path: String(item.path), content: String(item.content ?? "") });
      }
    }
  }
  if (!meta) return null;
  const summary = toSummary(meta);
  // In the order the metadata lists them.
  const order = new Map(summary.files.map((f, i) => [f.path, i]));
  files.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  return { ...summary, skillMd: String(meta.skillMd ?? ""), files };
}

/**
 * Writes `skill` (new or replacing one): its files first and the metadata
 * last, so the catalog never lists a skill whose files aren't there; then the
 * files it no longer has are removed.
 */
export async function putSkill(skill: Skill): Promise<void> {
  const before = await fileKeys(skill.id);
  await batchPut(
    tables.skills,
    skill.files.map((f) => ({
      skillId: skill.id,
      sk: `${FILE_PREFIX}${f.path}`,
      path: f.path,
      content: f.content,
    })),
  );
  const { id, files, ...rest } = skill;
  const meta: MetaRow = {
    ...rest,
    skillId: id,
    sk: META,
    files: files.map((f) => ({ path: f.path, size: bytes(f.content) })),
  };
  await ddb.send(new PutCommand({ TableName: tables.skills, Item: meta }));
  const kept = new Set(files.map((f) => `${FILE_PREFIX}${f.path}`));
  const stale = before.filter((sk) => !kept.has(sk));
  if (stale.length > 0)
    await batchDelete(
      tables.skills,
      stale.map((sk) => ({ skillId: id, sk })),
    );
}

async function fileKeys(id: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of paginateQuery(
    { client: ddb },
    {
      TableName: tables.skills,
      KeyConditionExpression: "skillId = :id AND begins_with(sk, :f)",
      ExpressionAttributeValues: { ":id": id, ":f": FILE_PREFIX },
      ProjectionExpression: "sk",
    },
  )) {
    keys.push(...(page.Items ?? []).map((i) => String(i.sk)));
  }
  return keys;
}

/** Removes a skill and its files. */
export async function deleteSkill(id: string): Promise<void> {
  const keys = [META, ...(await fileKeys(id))].map((sk) => ({ skillId: id, sk }));
  await batchDelete(tables.skills, keys);
}

/**
 * `skillMd` with frontmatter whose `name` is `slug` (Claude Code wants
 * lowercase-hyphen names; "Security Audit" becomes `security-audit`), and
 * frontmatter added for `name`/`description` when there was none.
 */
export function normalizeSkillMd(skillMd: string, slug: string, description: string): string {
  const text = skillMd.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const fm = parseFrontmatter(text);
  if (!fm) {
    const head = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
    return `${head}${text.trimStart()}`;
  }
  if (fm.data.name === slug) return text;
  const end = text.indexOf("\n---", 3);
  const head = text.slice(0, end);
  const named = /^name:.*$/m.test(head)
    ? head.replace(/^name:.*$/m, `name: ${slug}`)
    : head.replace(/^---\n/, `---\nname: ${slug}\n`);
  return `${named}${text.slice(end)}`;
}

/** A category from what the skill says about itself (an import's default). */
export function guessCategory(text: string): SkillCategory {
  const t = text.toLowerCase();
  if (/secur|vulnerab|audit|pen ?test|threat|auth/.test(t)) return "Security";
  if (/react|css|frontend|ui\b|component|browser/.test(t)) return "Frontend";
  if (/deploy|docker|kubernetes|ci\b|terraform|cdk|infra/.test(t)) return "DevOps";
  if (/sql|data|etl|analytics|pandas/.test(t)) return "Data";
  if (/api|backend|server|database|lambda/.test(t)) return "Backend";
  if (/workflow|review|commit|pr\b|process/.test(t)) return "Workflow";
  return "Other";
}

// --- The built-in skill ------------------------------------------------------

/** Cloudflare's security-audit skill, as snapshotted (see backend/scripts/snapshot-github-skill.mjs). */
export function seedSkill(now: number): Skill {
  const fm = parseFrontmatter(seed.skillMd);
  const slug = toSkillSlug(fm?.data.name ?? "security-audit");
  return {
    id: githubSkillId(seed.repoUrl, seed.repoPath),
    slug,
    name: slug,
    description: fm?.data.description ?? "",
    sourceType: "github",
    category: seed.category as SkillCategory,
    repoUrl: seed.repoUrl,
    repoPath: seed.repoPath,
    repoCommit: seed.repoCommit,
    skillMd: seed.skillMd,
    files: seed.files,
    authorId: "system",
    authorName: "Catálogo inicial",
    createdAt: now,
    updatedAt: now,
  };
}

let seeded = false;

/** Adds the built-in skill to the catalog the first time it's read (once ever). */
export async function ensureSeeded(now = Date.now()): Promise<void> {
  if (seeded) return;
  const skill = seedSkill(now);
  const marker = { skillId: CATALOG, sk: `seed#${skill.id}` };
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.skills, Key: marker }));
  if (!Item) {
    if (!(await getSkill(skill.id))) await putSkill(skill);
    await ddb.send(new PutCommand({ TableName: tables.skills, Item: { ...marker, at: now } }));
    log.info("skill catalog seeded", { skillId: skill.id, files: skill.files.length });
  }
  seeded = true;
}

/** Tests only. */
export function resetSeeded(): void {
  seeded = false;
}
