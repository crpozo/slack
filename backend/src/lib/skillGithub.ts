import {
  githubRepoUrl,
  isSafeSkillPath,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  parseFrontmatter,
  toSkillSlug,
  type GithubSkillRef,
  type SkillFile,
} from "@mindfultech/shared";
import { HttpError } from "./http";
import { log } from "./logger";
import { optionalSecret } from "./secret";
import { normalizeSkillMd } from "./skills";

// ---------------------------------------------------------------------------
// Importing a skill from a public GitHub repository (Phase 44). Two API
// calls (the commit, then its whole tree) find the skill's folder; its files
// come from raw.githubusercontent.com (not counted against the API's rate
// limit). An optional token (GITHUB_TOKEN, or the SecureString named by
// GITHUB_TOKEN_PARAMETER) lifts the limit from 60 to 5,000 calls an hour.
// ---------------------------------------------------------------------------

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
/** One request to GitHub: the whole import fits in API Gateway's 30 s. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Files read at once. */
const CONCURRENCY = 6;
/** Licence files at the repository's root that go along with a skill in a folder. */
const LICENSES = ["LICENSE", "LICENSE.md", "LICENSE.txt"];

export const githubToken = optionalSecret("GITHUB_TOKEN", "GITHUB_TOKEN_PARAMETER");

/** What an import read: a skill ready to save (or preview). */
export interface ImportedSkill {
  slug: string;
  description: string;
  skillMd: string;
  files: SkillFile[];
  repoUrl: string;
  /** The skill's folder ("" at the repository's root). */
  repoPath: string;
  /** The branch or tag asked for (the default branch when absent). */
  repoRef?: string;
  repoCommit: string;
  /** Files left out (too large, binary, past the limits), for the preview. */
  skipped: string[];
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

async function github(fetchImpl: typeof fetch, url: string, accept: string): Promise<Response> {
  const token = url.startsWith(API) ? await githubToken.get() : null;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept,
        "user-agent": "MindfulTechSlack/1.0 (+https://slack.mindfultech.ec)",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn("github unreachable", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new HttpError(502, "GitHub couldn't be reached. Try again in a moment.");
  }
  if (response.ok) return response;
  if (response.status === 404) {
    throw new HttpError(404, "That repository or folder doesn't exist on GitHub, or it's private.");
  }
  if (response.status === 403 || response.status === 429) {
    throw new HttpError(503, "GitHub is limiting requests right now. Try again in a few minutes.");
  }
  throw new HttpError(502, `GitHub answered ${response.status}.`);
}

const hidden = (path: string) =>
  path.split("/").some((p) => p.startsWith(".") || p === "node_modules");

/**
 * Where the skill is: the folder the URL names, else `SKILL.md` at the root,
 * else the only `SKILL.md` in the repository. Several and no folder named:
 * ask for one (listing them).
 */
function skillFolder(tree: TreeEntry[], asked: string | undefined): string {
  const has = (path: string) => tree.some((e) => e.type === "blob" && e.path === path);
  if (asked !== undefined) {
    if (has(`${asked}/SKILL.md`)) return asked;
    throw new HttpError(422, `There's no SKILL.md in ${asked}.`);
  }
  if (has("SKILL.md")) return "";
  const found = tree
    .filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/.test(e.path) && !hidden(e.path))
    .map((e) => e.path.replace(/\/?SKILL\.md$/, ""));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new HttpError(422, "This repository has no SKILL.md.");
  throw new HttpError(
    422,
    `This repository has ${found.length} skills (${found.slice(0, 5).join(", ")}${
      found.length > 5 ? ", …" : ""
    }). Paste the URL of one's folder.`,
  );
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

/** The skill at `ref` on GitHub: its SKILL.md (frontmatter checked) and companion files. */
export async function fetchGithubSkill(
  ref: GithubSkillRef,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportedSkill> {
  const repo = `${ref.owner}/${ref.repo}`;
  const commit = (
    await (
      await github(
        fetchImpl,
        `${API}/repos/${repo}/commits/${encodeURIComponent(ref.ref ?? "HEAD")}`,
        "application/vnd.github.sha",
      )
    ).text()
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new HttpError(502, "GitHub sent an unexpected answer.");
  const treeBody = (await (
    await github(
      fetchImpl,
      `${API}/repos/${repo}/git/trees/${commit}?recursive=1`,
      "application/vnd.github+json",
    )
  ).json()) as { tree?: TreeEntry[]; truncated?: boolean };
  const tree = treeBody.tree ?? [];
  const folder = skillFolder(tree, ref.path);
  const prefix = folder ? `${folder}/` : "";

  const skipped: string[] = [];
  const wanted: Array<{ from: string; path: string }> = [];
  let planned = 0;
  for (const entry of tree) {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (path === "SKILL.md" || hidden(path)) continue;
    const size = entry.size ?? 0;
    if (
      !isSafeSkillPath(path) ||
      size > MAX_SKILL_FILE_BYTES ||
      wanted.length >= MAX_SKILL_FILES ||
      planned + size > MAX_SKILL_TOTAL_BYTES
    ) {
      skipped.push(path);
      continue;
    }
    planned += size;
    wanted.push({ from: entry.path, path });
  }
  // A skill in a folder: the repository's licence goes along (attribution).
  if (folder && !wanted.some((w) => LICENSES.includes(w.path))) {
    const license = tree.find((e) => e.type === "blob" && LICENSES.includes(e.path));
    if (license && (license.size ?? 0) < 100_000)
      wanted.push({ from: license.path, path: license.path });
  }

  const raw = async (path: string) =>
    (
      await github(
        fetchImpl,
        `${RAW}/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
        "*/*",
      )
    ).text();
  const skillMdRaw = await raw(`${prefix}SKILL.md`);
  if (Buffer.byteLength(skillMdRaw, "utf8") > MAX_SKILL_MD_BYTES) {
    throw new HttpError(413, "Its SKILL.md is too large.");
  }
  const contents = await mapLimited(wanted, (w) => raw(w.from));
  const files: SkillFile[] = [];
  wanted.forEach((w, i) => {
    const content = contents[i]!;
    // Binary files (images, archives) aren't part of a text catalog.
    if (content.includes("\u0000")) skipped.push(w.path);
    else files.push({ path: w.path, content });
  });

  const fm = parseFrontmatter(skillMdRaw);
  const slug = toSkillSlug(fm?.data.name || folder.split("/").pop() || ref.repo);
  if (!slug) throw new HttpError(422, "Its SKILL.md has no usable name.");
  const description = (
    fm?.data.description ||
    (fm?.body ?? skillMdRaw)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("---")) ||
    `Skill imported from ${repo}.`
  )
    .replace(/\s+/g, " ")
    .slice(0, MAX_SKILL_DESCRIPTION);
  log.info("github skill read", {
    repo,
    folder,
    commit,
    files: files.length,
    skipped: skipped.length,
    truncatedTree: !!treeBody.truncated,
  });
  return {
    slug,
    description,
    skillMd: normalizeSkillMd(skillMdRaw, slug, description),
    files,
    repoUrl: githubRepoUrl(ref),
    repoPath: folder,
    // `HEAD` (a sync of a skill read from the default branch) isn't a branch to keep.
    ...(ref.ref && ref.ref !== "HEAD" && { repoRef: ref.ref }),
    repoCommit: commit,
    skipped,
  };
}
