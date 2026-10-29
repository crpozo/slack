import { z } from "zod";

// ---------------------------------------------------------------------------
// AI Skills (Phase 44): the team's catalog of Claude Code skills. A skill is a
// folder Claude Code loads from `.claude/skills/<slug>/` (one project) or
// `~/.claude/skills/<slug>/` (every project): a `SKILL.md` whose YAML
// frontmatter names and describes it, plus any companion files (scripts,
// references) it points to. The catalog keeps the team's own skills and ones
// imported from GitHub, and hands each out as a zip, a copyable terminal
// command, or (in the desktop app) a one-click install.
// ---------------------------------------------------------------------------

export const SKILL_CATEGORIES = [
  "Security",
  "Backend",
  "Frontend",
  "Workflow",
  "DevOps",
  "Data",
  "Other",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export type SkillSourceType = "team" | "github";

/** Claude Code's own limits for a skill's `name` and `description`. */
export const MAX_SKILL_SLUG = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
/** `SKILL.md` itself (Cloudflare's security-audit is 22 KB). */
export const MAX_SKILL_MD_BYTES = 100_000;
/** Companion files: how many, each, and all together. */
export const MAX_SKILL_FILES = 50;
export const MAX_SKILL_FILE_BYTES = 300_000;
export const MAX_SKILL_TOTAL_BYTES = 1_500_000;
export const MAX_SKILL_PROMPT = 2000;

/** Lowercase letters, numbers and single hyphens: the folder name and the `/command`. */
export const SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A file next to `SKILL.md`, by its path inside the skill's folder. */
export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillFileInfo {
  path: string;
  /** Bytes (UTF-8). */
  size: number;
}

/** What the catalog lists (`GET /skills`): everything but the contents. */
export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  sourceType: SkillSourceType;
  category: SkillCategory;
  /** GitHub skills: the repository (`https://github.com/<owner>/<repo>`). */
  repoUrl?: string;
  /** GitHub skills: the skill's folder inside the repository ("" at its root). */
  repoPath?: string;
  /** GitHub skills: the branch or tag read (the default branch when absent). */
  repoRef?: string;
  /** GitHub skills: the commit the files came from, and when they were read (epoch ms). */
  repoCommit?: string;
  syncedAt?: number;
  /** Companion files (not `SKILL.md`). */
  files: SkillFileInfo[];
  authorId: string;
  authorName: string;
  createdAt: number;
  updatedAt: number;
}

/** One skill in full (`GET /skills/{id}`). */
export interface Skill extends Omit<SkillSummary, "files"> {
  /** The whole `SKILL.md`, frontmatter included. */
  skillMd: string;
  files: SkillFile[];
}

export interface SkillsPage {
  skills: SkillSummary[];
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * A companion file's path: relative, `/`-separated, plain names (no `..`, no
 * hidden folders, nothing a filesystem could read as somewhere else), and not
 * `SKILL.md` itself.
 */
export function isSafeSkillPath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  if (parts.some((p) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(p) || p.length > 100)) return false;
  return path.toLowerCase() !== "skill.md";
}

const SkillFileSchema = z.object({
  path: z.string().refine(isSafeSkillPath, { message: "not a safe relative file path" }),
  content: z.string().refine((c) => utf8Bytes(c) <= MAX_SKILL_FILE_BYTES, {
    message: "file too large",
  }),
});

const SkillFilesSchema = z
  .array(SkillFileSchema)
  .max(MAX_SKILL_FILES)
  .refine((files) => new Set(files.map((f) => f.path)).size === files.length, {
    message: "two files have the same path",
  })
  .refine((files) => files.reduce((n, f) => n + utf8Bytes(f.content), 0) <= MAX_SKILL_TOTAL_BYTES, {
    message: "the files are too large together",
  });

/**
 * `POST /skills`: a team skill, new or (with `id`) edited. Either a whole
 * `SKILL.md` (its frontmatter gives the name and description) or a name and
 * description (the frontmatter is written for them), or both.
 */
export const SaveSkillSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(MAX_SKILL_SLUG).optional(),
    description: z.string().trim().min(1).max(MAX_SKILL_DESCRIPTION).optional(),
    category: z.enum(SKILL_CATEGORIES),
    skillMd: z
      .string()
      .refine((s) => utf8Bytes(s) <= MAX_SKILL_MD_BYTES, { message: "SKILL.md is too large" })
      .optional(),
    files: SkillFilesSchema.optional(),
  })
  .refine((v) => (v.skillMd?.trim() ?? "") !== "" || (!!v.name && !!v.description), {
    message: "send a SKILL.md, or a name and a description",
  });
export type SaveSkillInput = z.infer<typeof SaveSkillSchema>;

/** `POST /skills/import-github` (also "Sync from GitHub"). */
export const ImportGithubSkillSchema = z.object({
  repoUrl: z.string().trim().min(1).max(500),
  category: z.enum(SKILL_CATEGORIES).optional(),
  /** Only read and parse it, without saving (the import modal's preview). */
  preview: z.boolean().optional(),
});
export type ImportGithubSkillInput = z.infer<typeof ImportGithubSkillSchema>;

/** `POST /skills/generate`: an idea in plain words. */
export const GenerateSkillSchema = z.object({
  prompt: z.string().trim().min(10).max(MAX_SKILL_PROMPT),
});
export type GenerateSkillInput = z.infer<typeof GenerateSkillSchema>;

export interface GeneratedSkill {
  skillMd: string;
  name: string;
  description: string;
}

// --- SKILL.md frontmatter --------------------------------------------------

export interface Frontmatter {
  /** Top-level `key: value` pairs (folded and literal blocks joined). */
  data: Record<string, string>;
  /** The markdown after the closing `---`. */
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\(["\\/nt])/g, (_, c: string) => ({ n: "\n", t: "\t" })[c] ?? c);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The YAML frontmatter of a `SKILL.md`, or `null` without one. Reads what
 * skills use: `key: value` (plain or quoted), and `>` / `|` blocks; nested
 * keys (`metadata:` maps, lists) are kept as their raw text.
 */
export function parseFrontmatter(skillMd: string): Frontmatter | null {
  const text = skillMd.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = text.indexOf("\n", end + 4);
  const body = after < 0 ? "" : text.slice(after + 1);
  const lines = text.slice(4, end).split("\n");
  const data: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    const block: string[] = [];
    while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]!) && lines[i + 1] !== "") {
      block.push(lines[++i]!.trim());
    }
    if (/^[>|][-+]?$/.test(rest)) {
      data[key] = rest.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (rest === "" && block.length > 0) {
      data[key] = block.join("\n");
    } else {
      data[key] = unquote([rest, ...block].join(" "));
    }
  }
  return { data, body };
}

/** A value as YAML: plain when that's safe, double-quoted otherwise. */
function yamlValue(value: string): string {
  const v = value.replace(/\s+/g, " ").trim();
  const plain = /^[A-Za-z0-9(][^:#\n"'`{}[\],&*!|>%@]*$/.test(v) && !/\s$/.test(v);
  return plain ? v : JSON.stringify(v);
}

/** A `SKILL.md` with frontmatter for `name` and `description`, then `body`. */
export function buildSkillMd(name: string, description: string, body: string): string {
  const content = body.trim() || `# ${name}\n\nDescribe here what Claude should do, step by step.`;
  return `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(description)}\n---\n\n${content}\n`;
}

/** `text` as a skill name: lowercase words joined by hyphens, accents dropped. */
export function toSkillSlug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_SLUG)
    .replace(/-+$/, "");
}

// --- GitHub ----------------------------------------------------------------

export interface GithubSkillRef {
  owner: string;
  repo: string;
  /** A branch or tag (one path segment), when the URL names one. */
  ref?: string;
  /** The skill's folder in the repository, when the URL points inside it. */
  path?: string;
}

const GH_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * A GitHub URL (or `owner/repo`) as the repository and, when the URL points
 * inside it (`/tree/<ref>/<path>`, or a `SKILL.md` under `/blob/<ref>/`),
 * the branch and the skill's folder. `null` for anything else.
 */
export function parseGithubSkillUrl(input: string): GithubSkillRef | null {
  let text = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) text = `https://github.com/${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^(www\.)?github\.com$/i.test(url.hostname)) return null;
  const [owner, rawRepo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !GH_NAME.test(owner) || !GH_NAME.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  const result: GithubSkillRef = { owner, repo };
  if ((kind === "tree" || kind === "blob") && ref) {
    result.ref = decodeURIComponent(ref);
    let path = rest.map(decodeURIComponent).join("/");
    if (kind === "blob") path = path.replace(/(^|\/)SKILL\.md$/i, "");
    if (path) result.path = path;
  } else if (kind) {
    return null;
  }
  if (result.path && result.path.split("/").some((p) => p === ".." || p === ".")) return null;
  return result;
}

export const githubRepoUrl = (ref: Pick<GithubSkillRef, "owner" | "repo">) =>
  `https://github.com/${ref.owner}/${ref.repo}`;

// --- Installing ------------------------------------------------------------

export type SkillScope = "project" | "global";
export type SkillShell = "bash" | "powershell";

/** Where Claude Code looks for the skill. */
export const skillDir = (slug: string, scope: SkillScope) =>
  scope === "project" ? `.claude/skills/${slug}` : `~/.claude/skills/${slug}`;

/** Everything that goes in the skill's folder: `SKILL.md` first. */
export function skillBundle(skill: Pick<Skill, "skillMd" | "files">): SkillFile[] {
  return [{ path: "SKILL.md", content: skill.skillMd }, ...skill.files];
}

type Installable = Pick<Skill, "slug" | "sourceType" | "repoUrl" | "repoPath" | "repoRef"> &
  Partial<Pick<Skill, "skillMd" | "files">>;

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A heredoc delimiter that isn't a line of `content`. */
function delimiter(content: string): string {
  const lines = new Set(content.split("\n"));
  let tag = "SKILL_EOF";
  for (let n = 1; lines.has(tag); n++) tag = `SKILL_EOF_${n}`;
  return tag;
}

function githubCommand(skill: Installable, scope: SkillScope, shell: SkillShell): string {
  const url = skill.repoUrl!;
  const branch = skill.repoRef ? ` --branch ${skill.repoRef}` : "";
  const sub = skill.repoPath ? `/${skill.repoPath}` : "";
  if (shell === "bash") {
    const dest =
      scope === "project" ? `.claude/skills/${skill.slug}` : `$HOME/.claude/skills/${skill.slug}`;
    return [
      `tmp="$(mktemp -d)"`,
      `git clone --depth 1${branch} ${url} "$tmp"`,
      `mkdir -p "$(dirname "${dest}")"`,
      `rm -rf "${dest}"`,
      `cp -R "$tmp${sub}" "${dest}"`,
      `rm -rf "$tmp" "${dest}/.git"`,
    ].join(" && ");
  }
  const dest =
    scope === "project"
      ? `Join-Path (Get-Location) '.claude/skills/${skill.slug}'`
      : `Join-Path $HOME '.claude/skills/${skill.slug}'`;
  return [
    `$t = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())`,
    `git clone --depth 1${branch} ${url} $t`,
    `$d = ${dest}`,
    `Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue`,
    `New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null`,
    `Copy-Item -Recurse "$t${sub}" $d`,
    `Remove-Item -Recurse -Force $t, (Join-Path $d '.git') -ErrorAction SilentlyContinue`,
  ].join("; ");
}

function teamCommand(skill: Installable, scope: SkillScope, shell: SkillShell): string | null {
  if (skill.skillMd === undefined) return null;
  const files = skillBundle({ skillMd: skill.skillMd, files: skill.files ?? [] });
  const dirs = [
    ...new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")).filter(Boolean)),
  ];
  if (shell === "bash") {
    const dest =
      scope === "project" ? `.claude/skills/${skill.slug}` : `$HOME/.claude/skills/${skill.slug}`;
    const lines = [`d="${dest}"`, `rm -rf "$d"`, `mkdir -p "$d"`];
    for (const dir of dirs) lines.push(`mkdir -p "$d"/${shQuote(dir)}`);
    for (const file of files) {
      const body = file.content.endsWith("\n") ? file.content : `${file.content}\n`;
      const tag = delimiter(body);
      lines.push(`cat > "$d"/${shQuote(file.path)} <<'${tag}'`, `${body}${tag}`);
    }
    return lines.join("\n");
  }
  // PowerShell here-strings end at a line starting with '@: such a file can't be inlined.
  if (files.some((f) => f.content.split("\n").some((l) => l.startsWith("'@")))) return null;
  const dest =
    scope === "project"
      ? `Join-Path (Get-Location) '.claude/skills/${skill.slug}'`
      : `Join-Path $HOME '.claude/skills/${skill.slug}'`;
  const lines = [
    `$d = ${dest}`,
    `Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue`,
    `New-Item -ItemType Directory -Force $d | Out-Null`,
  ];
  for (const dir of dirs) {
    lines.push(`New-Item -ItemType Directory -Force (Join-Path $d ${psQuote(dir)}) | Out-Null`);
  }
  for (const file of files) {
    // WriteAllText: UTF-8 without a BOM (a BOM would hide the frontmatter).
    lines.push(
      `[IO.File]::WriteAllText((Join-Path $d ${psQuote(file.path)}), @'`,
      `${file.content.replace(/\n$/, "")}`,
      `'@ + "\`n")`,
    );
  }
  return lines.join("\n");
}

/**
 * A command that puts the skill in `.claude/skills/<slug>` (project) or
 * `~/.claude/skills/<slug>` (global), for bash/zsh (macOS, Linux, Git Bash)
 * or PowerShell (Windows). GitHub skills are cloned; team skills are written
 * out file by file. `null` when the skill can't be written this way (its
 * contents aren't loaded, or PowerShell can't inline a file): download it.
 */
export function installCommand(
  skill: Installable,
  scope: SkillScope,
  shell: SkillShell,
): string | null {
  if (skill.sourceType === "github" && skill.repoUrl) return githubCommand(skill, scope, shell);
  return teamCommand(skill, scope, shell);
}
