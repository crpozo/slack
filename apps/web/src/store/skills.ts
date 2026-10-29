import type { Skill, SkillSummary } from "@mindfultech/shared";
import { create } from "zustand";
import { skillsApi, type SkillsApi } from "../lib/skillsApi";

/**
 * The AI Skills catalog (Phase 44): the list, loaded when the view opens, and
 * each skill's contents, loaded when it's opened (and kept for the session).
 */
export interface SkillsState {
  status: "idle" | "loading" | "ready" | "error";
  skills: SkillSummary[];
  error: string | null;
  details: Record<string, Skill>;
  load: (force?: boolean) => Promise<void>;
  loadDetail: (id: string, force?: boolean) => Promise<Skill>;
  /** A skill saved, imported or synced: in the list, with its contents. */
  put: (skill: Skill) => void;
  drop: (id: string) => void;
}

const summaryOf = (skill: Skill): SkillSummary => ({
  ...skill,
  files: skill.files.map((f) => ({
    path: f.path,
    size: new TextEncoder().encode(f.content).length,
  })),
});

export function createSkillsStore(api: SkillsApi) {
  return create<SkillsState>((set, get) => ({
    status: "idle",
    skills: [],
    error: null,
    details: {},
    load: async (force = false) => {
      const s = get();
      if (s.status === "loading" || (!force && s.status === "ready")) return;
      set({ status: "loading", error: null });
      try {
        set({ status: "ready", skills: await api.list() });
      } catch (err) {
        set({
          status: get().skills.length ? "ready" : "error",
          error: err instanceof Error ? err.message : "Couldn't load the skills.",
        });
      }
    },
    loadDetail: async (id, force = false) => {
      const cached = get().details[id];
      if (cached && !force) return cached;
      const skill = await api.get(id);
      set((s) => ({ details: { ...s.details, [id]: skill } }));
      return skill;
    },
    put: (skill) =>
      set((s) => ({
        details: { ...s.details, [skill.id]: skill },
        skills: [...s.skills.filter((x) => x.id !== skill.id), summaryOf(skill)].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      })),
    drop: (id) =>
      set((s) => {
        const details = { ...s.details };
        delete details[id];
        return { details, skills: s.skills.filter((x) => x.id !== id) };
      }),
  }));
}

export const useSkills = createSkillsStore(skillsApi);
