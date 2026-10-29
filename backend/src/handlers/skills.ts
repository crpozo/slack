import Anthropic from "@anthropic-ai/sdk";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  GenerateSkillSchema,
  ImportGithubSkillSchema,
  parseFrontmatter,
  parseGithubSkillUrl,
  SaveSkillSchema,
  skillBundle,
  toSkillSlug,
  type GeneratedSkill,
  type Skill,
  type SkillsPage,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
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
import { generatedSkillFrom, generateSkillRequest } from "../lib/skillGenerate";
import { fetchGithubSkill, type ImportedSkill } from "../lib/skillGithub";
import {
  deleteSkill,
  ensureSeeded,
  getSkill,
  githubSkillId,
  guessCategory,
  listSkills,
  normalizeSkillMd,
  putSkill,
} from "../lib/skills";
import { defaultDisplayName } from "../lib/users";
import { createZip } from "../lib/zip";

let model: ClaudeModel | null = null;
let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Tests swap the model and GitHub. */
export function useSkillModel(next: ClaudeModel | null): void {
  model = next;
}
export function useGithubFetch(next: typeof fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

/** One generation inside API Gateway's 30 s. */
const GENERATE_TIMEOUT_MS = 26_000;

function skillIdOf(event: HttpEvent): string {
  const id = pathParam(event, "id");
  if (!/^[\w-]{1,64}$/.test(id)) throw notFound("Skill not found");
  return id;
}

async function authorName(caller: HttpCaller): Promise<string> {
  try {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: tables.users,
        Key: { userId: caller.userId },
        ProjectionExpression: "displayName",
      }),
    );
    if (typeof Item?.displayName === "string" && Item.displayName) return Item.displayName;
  } catch (err) {
    log.warn("author name lookup failed", { userId: caller.userId, ...errorFields(err) });
  }
  return defaultDisplayName(caller.email);
}

/** Whoever added a skill may change or remove it; admins may too (and only they, the built-in one). */
const mayChange = (skill: Pick<Skill, "authorId">, caller: HttpCaller) =>
  caller.role === "admin" || skill.authorId === caller.userId;

/** Another skill already installs into the same folder: one `/command`, one skill. */
async function assertSlugFree(slug: string, id: string): Promise<void> {
  const taken = (await listSkills()).find((s) => s.slug === slug && s.id !== id);
  if (taken) {
    throw new HttpError(409, `A skill named ${slug} is already in the catalog (${taken.name}).`);
  }
}

/** `POST /skills`: a team skill, new or edited. */
async function saveSkill(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const input = parseBody(SaveSkillSchema, event);
  const fm = input.skillMd?.trim() ? parseFrontmatter(input.skillMd) : null;
  // SKILL.md's own frontmatter is what Claude Code reads: it wins.
  const name = fm?.data.name || input.name || "";
  const description = (fm?.data.description || input.description || "").replace(/\s+/g, " ").trim();
  const slug = toSkillSlug(name);
  if (!slug) throw new HttpError(400, "name: use letters or numbers");
  if (!description)
    throw new HttpError(400, "description: say what the skill does and when to use it");
  if (description.length > 1024) throw new HttpError(400, "description: at most 1024 characters");

  const now = Date.now();
  const existing = input.id ? await getSkill(input.id) : null;
  if (input.id && !existing) throw notFound("Skill not found");
  if (existing && existing.sourceType !== "team") {
    throw new HttpError(409, "GitHub skills are updated with Sync from GitHub");
  }
  if (existing && !mayChange(existing, caller)) {
    throw forbidden("Only its author or an admin can edit this skill");
  }
  const id = existing?.id ?? `sk_${ulid(now)}`;
  await assertSlugFree(slug, id);
  const skillMd = input.skillMd?.trim()
    ? normalizeSkillMd(input.skillMd, slug, description)
    : normalizeSkillMd(
        `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${slug}\n`,
        slug,
        description,
      );
  const skill: Skill = {
    id,
    slug,
    name: slug,
    description,
    sourceType: "team",
    category: input.category,
    skillMd,
    files: input.files ?? existing?.files ?? [],
    authorId: existing?.authorId ?? caller.userId,
    authorName: existing?.authorName ?? (await authorName(caller)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putSkill(skill);
  log.info("skill saved", { skillId: id, slug, userId: caller.userId, edit: !!existing });
  return json(existing ? 200 : 201, { skill });
}

/** `POST /skills/import-github`: read a skill from GitHub; save it (or only preview it). */
async function importGithub(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const input = parseBody(ImportGithubSkillSchema, event);
  const ref = parseGithubSkillUrl(input.repoUrl);
  if (!ref) {
    throw new HttpError(
      400,
      "repoUrl: a GitHub repository URL, e.g. https://github.com/owner/repo",
    );
  }
  const imported: ImportedSkill = await fetchGithubSkill(ref, fetchImpl);
  const id = githubSkillId(imported.repoUrl, imported.repoPath);
  const existing = await getSkill(id);
  const now = Date.now();
  const { skipped, ...fields } = imported;
  const skill: Skill = {
    ...fields,
    id,
    name: imported.slug,
    sourceType: "github",
    category:
      input.category ??
      existing?.category ??
      guessCategory(`${imported.slug} ${imported.description}`),
    syncedAt: now,
    authorId: existing?.authorId ?? caller.userId,
    authorName: existing?.authorName ?? (await authorName(caller)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (input.preview) return json(200, { skill, skipped, exists: !!existing });
  await assertSlugFree(skill.slug, id);
  await putSkill(skill);
  log.info("github skill imported", {
    skillId: id,
    repo: imported.repoUrl,
    commit: imported.repoCommit,
    userId: caller.userId,
    sync: !!existing,
  });
  return json(existing ? 200 : 201, { skill, skipped });
}

/** `POST /skills/generate`: a SKILL.md from an idea (Claude Haiku 5.5). Nothing is saved. */
async function generate(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const { prompt } = parseBody(GenerateSkillSchema, event);
  const started = Date.now();
  let response: Anthropic.Message;
  try {
    response = await (model ??= bedrockModel(GENERATE_TIMEOUT_MS, 0)).create(
      generateSkillRequest(prompt),
    );
  } catch (err) {
    log.error("skill generation failed", {
      userId: caller.userId,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    throw new HttpError(
      err instanceof Anthropic.RateLimitError ? 503 : 502,
      "The skill couldn't be generated right now. Try again.",
    );
  }
  const outcome = generatedSkillFrom(response);
  log.info("skill generated", {
    userId: caller.userId,
    ok: outcome.ok,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ms: Date.now() - started,
  });
  if (!outcome.ok) throw new HttpError(502, outcome.error);
  const body: GeneratedSkill = outcome.skill;
  return json(200, body);
}

/** `GET /skills/{id}/download`: `<slug>/SKILL.md` and its files, zipped. */
async function download(event: HttpEvent): Promise<HttpResult> {
  const skill = await getSkill(skillIdOf(event));
  if (!skill) throw notFound("Skill not found");
  const zip = createZip(
    skillBundle(skill).map((f) => ({ path: `${skill.slug}/${f.path}`, content: f.content })),
    new Date(skill.updatedAt),
  );
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${skill.slug}.zip"`,
      "cache-control": "no-store",
    },
    body: zip.toString("base64"),
    isBase64Encoded: true,
  };
}

/**
 * AI Skills (Phase 44): the team's catalog of Claude Code skills. Everyone
 * but guests reads and adds skills; whoever added one (or an admin) edits or
 * removes it.
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  switch (event.routeKey) {
    case "GET /skills": {
      await ensureSeeded();
      const body: SkillsPage = { skills: await listSkills() };
      return json(200, body);
    }
    case "GET /skills/{id}": {
      const skill = await getSkill(skillIdOf(event));
      if (!skill) throw notFound("Skill not found");
      return json(200, { skill });
    }
    case "GET /skills/{id}/download":
      return download(event);
    case "POST /skills":
      return saveSkill(event, caller);
    case "POST /skills/import-github":
      return importGithub(event, caller);
    case "POST /skills/generate":
      return generate(event, caller);
    case "DELETE /skills/{id}": {
      const id = skillIdOf(event);
      const skill = await getSkill(id);
      if (!skill) throw notFound("Skill not found");
      if (!mayChange(skill, caller)) {
        throw forbidden("Only whoever added this skill, or an admin, can remove it");
      }
      await deleteSkill(id);
      log.info("skill deleted", { skillId: id, userId: caller.userId });
      return json(200, { deleted: id });
    }
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});
