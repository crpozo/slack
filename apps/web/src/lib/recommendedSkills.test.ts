import { parseGithubSkillUrl, SKILL_CATEGORIES, toSkillSlug } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import { missingRecommended, RECOMMENDED_SKILLS } from "./recommendedSkills";

describe("recommended skills (Phase 61)", () => {
  it("each points at a skill folder the importer can read, once", () => {
    for (const r of RECOMMENDED_SKILLS) {
      const ref = parseGithubSkillUrl(r.url);
      expect(ref, r.slug).toMatchObject({ ref: "main", path: `skills/${r.slug}` });
      expect(["anthropics/skills", "obra/superpowers"]).toContain(`${ref?.owner}/${ref?.repo}`);
      expect(toSkillSlug(r.slug)).toBe(r.slug);
      expect(SKILL_CATEGORIES).toContain(r.category);
    }
    expect(new Set(RECOMMENDED_SKILLS.map((r) => r.slug)).size).toBe(RECOMMENDED_SKILLS.length);
  });

  it("offers only what the catalog doesn't have yet", () => {
    const left = missingRecommended([{ slug: "pdf" }, { slug: "security-audit" }]);
    expect(left).toHaveLength(RECOMMENDED_SKILLS.length - 1);
    expect(left.some((r) => r.slug === "pdf")).toBe(false);
  });
});
