import {
  skillBundle,
  type Skill,
  type SkillCategory,
  type SkillShell,
  type SkillSummary,
} from "@mindfultech/shared";
import { isDesktopApp } from "./desktop";

// ---------------------------------------------------------------------------
// AI Skills (Phase 44), the view's pure parts: search, filters, labels, and
// the desktop app's one-click install.
// ---------------------------------------------------------------------------

export type SkillFilter = "all" | "team" | "github" | "security" | "dev";

export const SKILL_FILTERS: Array<{ id: SkillFilter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "team", label: "Equipo MindfulTech" },
  { id: "github", label: "GitHub / Oficial" },
  { id: "security", label: "Seguridad" },
  { id: "dev", label: "Desarrollo" },
];

export const CATEGORY_LABELS: Record<SkillCategory, string> = {
  Security: "Seguridad",
  Backend: "Backend",
  Frontend: "Frontend",
  Workflow: "Flujo de trabajo",
  DevOps: "DevOps",
  Data: "Datos",
  Other: "Otros",
};

const DEVELOPMENT = new Set<SkillCategory>(["Backend", "Frontend", "DevOps", "Data"]);

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/** Skills matching `query` (name, slug or description; accents and case ignored) and `filter`. */
export function filterSkills(
  skills: SkillSummary[],
  query: string,
  filter: SkillFilter,
): SkillSummary[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return skills.filter((s) => {
    if (filter === "team" && s.sourceType !== "team") return false;
    if (filter === "github" && s.sourceType !== "github") return false;
    if (filter === "security" && s.category !== "Security") return false;
    if (filter === "dev" && !DEVELOPMENT.has(s.category)) return false;
    const haystack = fold(`${s.name} ${s.slug} ${s.description}`);
    return words.every((w) => haystack.includes(w));
  });
}

/** The shell a copied command is for: PowerShell on Windows, bash elsewhere. */
export function defaultShell(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): SkillShell {
  return /Windows/i.test(userAgent) ? "powershell" : "bash";
}

/** "owner/repo" of a GitHub skill's repository URL. */
export const repoLabel = (repoUrl: string) => repoUrl.replace(/^https:\/\/github\.com\//i, "");

/** Whoever added a skill may edit or remove it, and admins may too. */
export const canChangeSkill = (
  skill: Pick<SkillSummary, "authorId">,
  me: { userId: string; role?: string } | null,
) => !!me && (me.role === "admin" || skill.authorId === me.userId);

/** Hands a Blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- The desktop app's install (apps/desktop: `install_skill`) ---------------------

interface TauriCore {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}
const tauriCore = (): TauriCore | undefined =>
  (window as Window & { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;

/** The desktop app can write the skill into ~/.claude/skills itself. */
export const canInstallInDesktop = (): boolean => isDesktopApp() && !!tauriCore();

/**
 * Writes the skill's folder to `~/.claude/skills/<slug>/` through the desktop
 * app; resolves with where it went. Older desktop apps don't have the command:
 * that rejects, and the view offers the download instead.
 */
export async function installInDesktop(
  skill: Pick<Skill, "slug" | "skillMd" | "files">,
): Promise<string> {
  const core = tauriCore();
  if (!core) throw new Error("Only in the desktop app");
  const path = await core.invoke("install_skill", { slug: skill.slug, files: skillBundle(skill) });
  return typeof path === "string" ? path : `~/.claude/skills/${skill.slug}`;
}
