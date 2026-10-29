import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSkillMd,
  GenerateSkillSchema,
  ImportGithubSkillSchema,
  installCommand,
  isSafeSkillPath,
  MAX_SKILL_FILES,
  parseFrontmatter,
  parseGithubSkillUrl,
  SaveSkillSchema,
  skillBundle,
  skillDir,
  toSkillSlug,
} from "./skills";

const CLOUDFLARE_FRONTMATTER = `---
name: security-audit
description: Security guidance and vulnerability review for codebases, APIs, services, CLI tools, libraries, and daemons. Use for security questions, focused reviews, vulnerability research, security audits, or pen tests.
---

# Security Audit

Find vulnerabilities that violate a real trust boundary.
`;

describe("SKILL.md frontmatter", () => {
  it("reads name and description, and keeps the body", () => {
    const fm = parseFrontmatter(CLOUDFLARE_FRONTMATTER)!;
    expect(fm.data.name).toBe("security-audit");
    expect(fm.data.description).toMatch(/^Security guidance and vulnerability review/);
    expect(fm.body.trim()).toMatch(/^# Security Audit/);
  });

  it("reads quoted values, folded and literal blocks, CRLF and a BOM; ignores nested maps", () => {
    const fm = parseFrontmatter(
      "﻿---\r\nname: 'it''s-a-skill'\r\ndescription: >\r\n  Folded\r\n  lines\r\nnotes: |\r\n  one\r\n  two\r\nquoted: \"a: b \\\"c\\\"\"\r\nmetadata:\r\n  version: 1\r\n---\r\nBody\r\n",
    )!;
    expect(fm.data).toMatchObject({
      name: "it's-a-skill",
      description: "Folded lines",
      notes: "one\ntwo",
      quoted: 'a: b "c"',
      metadata: "version: 1",
    });
    expect(fm.body).toBe("Body\n");
  });

  it("is null without frontmatter, or without its closing line", () => {
    expect(parseFrontmatter("# Just markdown")).toBeNull();
    expect(parseFrontmatter("---\nname: x\n")).toBeNull();
  });

  it("writes frontmatter that reads back, quoting what YAML would misread", () => {
    const md = buildSkillMd(
      "aws-cdk-iam",
      "Audits IAM: least privilege, wildcards #1",
      "# Steps\n1. Read",
    );
    expect(md.startsWith('---\nname: aws-cdk-iam\ndescription: "Audits IAM: least privilege')).toBe(
      true,
    );
    expect(parseFrontmatter(md)!.data).toEqual({
      name: "aws-cdk-iam",
      description: "Audits IAM: least privilege, wildcards #1",
    });
    expect(parseFrontmatter(buildSkillMd("x", "Plain words", ""))!.body.trim()).toMatch(/^# x/);
  });

  it("makes slugs Claude Code accepts", () => {
    expect(toSkillSlug("Auditoría de IAM en CDK!")).toBe("auditoria-de-iam-en-cdk");
    expect(toSkillSlug("  --Security   Audit-- ")).toBe("security-audit");
    expect(toSkillSlug("a".repeat(80))).toHaveLength(64);
  });
});

describe("GitHub URLs", () => {
  it("reads a repository, a folder in a branch, a SKILL.md, and owner/repo", () => {
    expect(parseGithubSkillUrl("https://github.com/cloudflare/security-audit-skill")).toEqual({
      owner: "cloudflare",
      repo: "security-audit-skill",
    });
    expect(
      parseGithubSkillUrl(
        "https://github.com/cloudflare/security-audit-skill/tree/main/skills/security-audit",
      ),
    ).toEqual({
      owner: "cloudflare",
      repo: "security-audit-skill",
      ref: "main",
      path: "skills/security-audit",
    });
    expect(
      parseGithubSkillUrl("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"),
    ).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
    expect(parseGithubSkillUrl("cloudflare/security-audit-skill.git")).toMatchObject({
      repo: "security-audit-skill",
    });
    expect(parseGithubSkillUrl("https://www.github.com/a/b.git/")).toEqual({
      owner: "a",
      repo: "b",
    });
  });

  it("refuses other hosts, plain http, issues pages and path tricks", () => {
    for (const bad of [
      "http://github.com/a/b",
      "https://gitlab.com/a/b",
      "https://github.com.evil.example/a/b",
      "https://github.com/a",
      "https://github.com/a/b/issues/1",
      "https://github.com/a/b/tree/main/../../etc",
      "not a url",
    ]) {
      expect([bad, parseGithubSkillUrl(bad)]).toEqual([bad, null]);
    }
  });
});

describe("request schemas", () => {
  it("wants a SKILL.md, or a name and a description", () => {
    expect(SaveSkillSchema.safeParse({ category: "Security", skillMd: "x" }).success).toBe(true);
    expect(
      SaveSkillSchema.safeParse({ category: "Backend", name: "n", description: "d" }).success,
    ).toBe(true);
    expect(SaveSkillSchema.safeParse({ category: "Backend", name: "n" }).success).toBe(false);
    expect(SaveSkillSchema.safeParse({ category: "Nope", skillMd: "x" }).success).toBe(false);
  });

  it("keeps companion files inside the skill's folder, unique and bounded", () => {
    const save = (files: Array<{ path: string; content: string }>) =>
      SaveSkillSchema.safeParse({ category: "Workflow", skillMd: "x", files }).success;
    expect(save([{ path: "scripts/check.sh", content: "echo ok" }])).toBe(true);
    for (const path of ["../x", "/etc/passwd", "a\\b", ".git/config", "SKILL.md", "a//b", ""]) {
      expect([path, isSafeSkillPath(path)]).toEqual([path, false]);
    }
    expect(
      save([
        { path: "a.md", content: "" },
        { path: "a.md", content: "" },
      ]),
    ).toBe(false);
    expect(
      save(
        Array.from({ length: MAX_SKILL_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, content: "" })),
      ),
    ).toBe(false);
  });

  it("checks the import and generate bodies", () => {
    expect(ImportGithubSkillSchema.safeParse({ repoUrl: "a/b" }).success).toBe(true);
    expect(ImportGithubSkillSchema.safeParse({ repoUrl: "" }).success).toBe(false);
    expect(GenerateSkillSchema.safeParse({ prompt: "audit CDK IAM permissions" }).success).toBe(
      true,
    );
    expect(GenerateSkillSchema.safeParse({ prompt: "short" }).success).toBe(false);
  });
});

describe("install commands", () => {
  const github = {
    slug: "security-audit",
    sourceType: "github" as const,
    repoUrl: "https://github.com/cloudflare/security-audit-skill",
    repoPath: "skills/security-audit",
  };

  it("clones a GitHub skill's folder into the project or the home directory", () => {
    expect(installCommand(github, "project", "bash")).toBe(
      'tmp="$(mktemp -d)" && git clone --depth 1 https://github.com/cloudflare/security-audit-skill "$tmp" && mkdir -p "$(dirname ".claude/skills/security-audit")" && rm -rf ".claude/skills/security-audit" && cp -R "$tmp/skills/security-audit" ".claude/skills/security-audit" && rm -rf "$tmp" ".claude/skills/security-audit/.git"',
    );
    expect(installCommand({ ...github, repoRef: "v2" }, "global", "bash")).toContain(
      'git clone --depth 1 --branch v2 https://github.com/cloudflare/security-audit-skill "$tmp"',
    );
    expect(installCommand(github, "global", "bash")).toContain(
      '"$HOME/.claude/skills/security-audit"',
    );
    const ps = installCommand(github, "global", "powershell")!;
    expect(ps).toContain("$d = Join-Path $HOME '.claude/skills/security-audit'");
    expect(ps).toContain('Copy-Item -Recurse "$t/skills/security-audit" $d');
    expect(skillDir("x", "project")).toBe(".claude/skills/x");
    expect(skillDir("x", "global")).toBe("~/.claude/skills/x");
  });

  const team = {
    slug: "cdk-iam",
    sourceType: "team" as const,
    skillMd: buildSkillMd(
      "cdk-iam",
      "Audits CDK IAM",
      "# Steps\nUse 'quotes' and $HOME literally.\nSKILL_EOF\n",
    ),
    files: [
      { path: "scripts/check.sh", content: '#!/bin/sh\necho "$1"' },
      { path: "REFERENCE.md", content: "Line\n" },
    ],
  };

  it("writes a team skill's files exactly, with bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-"));
    try {
      execFileSync("bash", ["-c", installCommand(team, "project", "bash")!], { cwd: dir });
      const read = (p: string) => readFileSync(join(dir, ".claude/skills/cdk-iam", p), "utf8");
      expect(read("SKILL.md")).toBe(team.skillMd);
      expect(read("scripts/check.sh")).toBe('#!/bin/sh\necho "$1"\n');
      expect(read("REFERENCE.md")).toBe("Line\n");
      // Running it again replaces the folder.
      execFileSync("bash", ["-c", installCommand(team, "project", "bash")!], { cwd: dir });
      expect(read("SKILL.md")).toBe(team.skillMd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a team skill with PowerShell here-strings (UTF-8, no BOM), unless it can't", () => {
    const ps = installCommand(team, "global", "powershell")!;
    expect(ps).toContain("$d = Join-Path $HOME '.claude/skills/cdk-iam'");
    expect(ps).toContain("[IO.File]::WriteAllText((Join-Path $d 'SKILL.md'), @'");
    expect(ps).toContain("New-Item -ItemType Directory -Force (Join-Path $d 'scripts')");
    expect(
      installCommand(
        { ...team, files: [{ path: "x.md", content: "'@ breaks it" }] },
        "project",
        "powershell",
      ),
    ).toBeNull();
    // Not loaded yet: no command.
    expect(installCommand({ ...team, skillMd: undefined }, "project", "bash")).toBeNull();
    expect(skillBundle(team).map((f) => f.path)).toEqual([
      "SKILL.md",
      "scripts/check.sh",
      "REFERENCE.md",
    ]);
  });
});
