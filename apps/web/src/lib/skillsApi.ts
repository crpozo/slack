import type {
  GeneratedSkill,
  ImportGithubSkillInput,
  SaveSkillInput,
  Skill,
  SkillsPage,
  SkillSummary,
} from "@mindfultech/shared";
import { request, requestBlob } from "./tasksApi";

/** What an import read: the skill, the files left out, and whether it's already in the catalog. */
export interface ImportResult {
  skill: Skill;
  skipped: string[];
  exists?: boolean;
}

/** AI Skills (Phase 44), on the same HTTP API and auth as the Task Manager. */
export const skillsApi = {
  list: () => request<SkillsPage>("GET", "/skills").then((r) => r.skills),
  get: (id: string) =>
    request<{ skill: Skill }>("GET", `/skills/${encodeURIComponent(id)}`).then((r) => r.skill),
  save: (input: SaveSkillInput) =>
    request<{ skill: Skill }>("POST", "/skills", input).then((r) => r.skill),
  remove: (id: string) =>
    request<{ deleted: string }>("DELETE", `/skills/${encodeURIComponent(id)}`),
  importGithub: (input: ImportGithubSkillInput) =>
    request<ImportResult>("POST", "/skills/import-github", input),
  generate: (prompt: string) => request<GeneratedSkill>("POST", "/skills/generate", { prompt }),
  download: (id: string) => requestBlob(`/skills/${encodeURIComponent(id)}/download`),
};

export type SkillsApi = typeof skillsApi;
export type { SkillSummary };
