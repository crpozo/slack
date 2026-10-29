import type { SkillSummary } from "@mindfultech/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canChangeSkill,
  canInstallInDesktop,
  defaultShell,
  filterSkills,
  installInDesktop,
  repoLabel,
} from "./skills";

const skill = (patch: Partial<SkillSummary>): SkillSummary => ({
  id: "x",
  slug: "x",
  name: "x",
  description: "",
  sourceType: "team",
  category: "Workflow",
  files: [],
  authorId: "u1",
  authorName: "Ana",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const catalog = [
  skill({
    id: "a",
    slug: "security-audit",
    name: "security-audit",
    description: "Auditoría de seguridad",
    sourceType: "github",
    category: "Security",
  }),
  skill({
    id: "b",
    slug: "cdk-iam",
    name: "cdk-iam",
    description: "Reviews IAM in CDK stacks",
    category: "DevOps",
  }),
  skill({
    id: "c",
    slug: "release-notes",
    name: "release-notes",
    description: "Drafts release notes",
    category: "Workflow",
  }),
];
const ids = (list: SkillSummary[]) => list.map((s) => s.id);

describe("AI Skills catalog helpers", () => {
  it("searches name, slug and description, accents and case ignored, every word", () => {
    expect(ids(filterSkills(catalog, "AUDITORIA", "all"))).toEqual(["a"]);
    expect(ids(filterSkills(catalog, "iam cdk", "all"))).toEqual(["b"]);
    expect(ids(filterSkills(catalog, "notes release", "all"))).toEqual(["c"]);
    expect(ids(filterSkills(catalog, "", "all"))).toEqual(["a", "b", "c"]);
  });

  it("filters by source and by kind", () => {
    expect(ids(filterSkills(catalog, "", "team"))).toEqual(["b", "c"]);
    expect(ids(filterSkills(catalog, "", "github"))).toEqual(["a"]);
    expect(ids(filterSkills(catalog, "", "security"))).toEqual(["a"]);
    expect(ids(filterSkills(catalog, "", "dev"))).toEqual(["b"]);
  });

  it("knows the shell, the repository and who may change a skill", () => {
    expect(defaultShell("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("powershell");
    expect(defaultShell("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe("bash");
    expect(repoLabel("https://github.com/cloudflare/security-audit-skill")).toBe(
      "cloudflare/security-audit-skill",
    );
    expect(canChangeSkill({ authorId: "u1" }, { userId: "u1" })).toBe(true);
    expect(canChangeSkill({ authorId: "u1" }, { userId: "u2", role: "admin" })).toBe(true);
    expect(canChangeSkill({ authorId: "u1" }, { userId: "u2" })).toBe(false);
    expect(canChangeSkill({ authorId: "u1" }, null)).toBe(false);
  });
});

describe("the desktop app's install", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("isn't there in a browser", async () => {
    vi.stubGlobal("window", {});
    expect(canInstallInDesktop()).toBe(false);
    await expect(installInDesktop({ slug: "x", skillMd: "", files: [] })).rejects.toThrow(
      /desktop app/,
    );
  });

  it("hands SKILL.md and its files to install_skill and says where they went", async () => {
    const invoke = vi.fn(async () => "/Users/ana/.claude/skills/cdk-iam");
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    expect(canInstallInDesktop()).toBe(true);
    const where = await installInDesktop({
      slug: "cdk-iam",
      skillMd: "---\nname: cdk-iam\n---\n",
      files: [{ path: "scripts/scan.sh", content: "echo" }],
    });
    expect(where).toBe("/Users/ana/.claude/skills/cdk-iam");
    expect(invoke).toHaveBeenCalledWith("install_skill", {
      slug: "cdk-iam",
      files: [
        { path: "SKILL.md", content: "---\nname: cdk-iam\n---\n" },
        { path: "scripts/scan.sh", content: "echo" },
      ],
    });
  });
});
