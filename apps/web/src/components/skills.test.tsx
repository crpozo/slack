// @vitest-environment jsdom
import { buildSkillMd, type Skill, type SkillSummary } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/skillsApi", () => ({
  skillsApi: {
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    importGithub: vi.fn(),
    generate: vi.fn(),
    download: vi.fn(),
  },
}));

import { skillsApi } from "../lib/skillsApi";
import { configureTasksApi } from "../lib/tasksApi";
import { useChat } from "../store";
import { useSkills } from "../store/skills";
import { SkillsView } from "./SkillsView";

const api = vi.mocked(skillsApi);
const ME = { userId: "u-ana", email: "ana@example.com", role: "member" as const };

const seed: Skill = {
  id: "gh_seed",
  slug: "security-audit",
  name: "security-audit",
  description: "Security guidance and vulnerability review for codebases.",
  sourceType: "github",
  category: "Security",
  repoUrl: "https://github.com/cloudflare/security-audit-skill",
  repoPath: "skills/security-audit",
  repoCommit: "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8",
  skillMd: buildSkillMd(
    "security-audit",
    "Security guidance.",
    "# Security Audit\n\n- Find real trust boundaries",
  ),
  files: [{ path: "HUNTING.md", content: "# Hunting" }],
  authorId: "system",
  authorName: "Catálogo inicial",
  createdAt: 1,
  updatedAt: 1,
};
const team: Skill = {
  ...seed,
  id: "sk_team",
  slug: "release-notes",
  name: "release-notes",
  description: "Drafts release notes from merged pull requests.",
  sourceType: "team",
  category: "Workflow",
  repoUrl: undefined,
  repoPath: undefined,
  repoCommit: undefined,
  skillMd: buildSkillMd("release-notes", "Drafts release notes.", "# Steps"),
  files: [],
  authorId: ME.userId,
  authorName: "Ana",
};
const summary = (s: Skill): SkillSummary => ({
  ...s,
  files: s.files.map((f) => ({ path: f.path, size: f.content.length })),
});

beforeEach(() => {
  configureTasksApi("https://api.fake.example");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  useChat.setState({ me: ME, toast: null });
  useSkills.setState({ status: "idle", skills: [], error: null, details: {} });
  api.list.mockResolvedValue([summary(seed), summary(team)]);
  api.get.mockImplementation(async (id: string) => (id === seed.id ? seed : team));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const cards = () => screen.queryAllByRole("article").map((a) => a.getAttribute("data-skill-card"));

describe("the AI Skills dashboard", () => {
  it("shows the catalog with its header, invocation and source badges", async () => {
    render(<SkillsView />);
    expect(screen.getByRole("heading", { name: "AI Skills" })).toBeTruthy();
    expect(
      screen.getByText("Catálogo de skills de Claude Code del equipo y la comunidad"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Importar de GitHub/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Crear Skill/ })).toBeTruthy();
    await waitFor(() => expect(cards()).toEqual(["security-audit", "release-notes"]));
    const audit = screen.getAllByRole("article")[0]!;
    expect(within(audit).getByText("/security-audit")).toBeTruthy();
    expect(
      within(audit)
        .getByRole("link", { name: /cloudflare\/security-audit-skill/ })
        .getAttribute("href"),
    ).toBe("https://github.com/cloudflare/security-audit-skill");
    expect(within(screen.getAllByRole("article")[1]!).getByText("MindfulTech")).toBeTruthy();
  });

  it("searches as you type and filters with the pills", async () => {
    render(<SkillsView />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar skills" }), {
      target: { value: "release" },
    });
    expect(cards()).toEqual(["release-notes"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar skills" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "GitHub / Oficial" }));
    expect(cards()).toEqual(["security-audit"]);
    fireEvent.click(screen.getByRole("button", { name: "Seguridad" }));
    expect(cards()).toEqual(["security-audit"]);
    fireEvent.click(screen.getByRole("button", { name: "Equipo MindfulTech" }));
    expect(cards()).toEqual(["release-notes"]);
  });

  it("opens a skill: rendered preview, its files, and the commands to install it", async () => {
    render(<SkillsView />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(
      within(screen.getAllByRole("article")[0]!).getByRole("button", { name: "Ver detalle" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Security Audit" })).toBeTruthy(),
    );
    expect(api.get).toHaveBeenCalledWith("gh_seed");

    fireEvent.click(screen.getByRole("tab", { name: "Archivos" }));
    fireEvent.click(screen.getByRole("button", { name: /HUNTING\.md/ }));
    expect(screen.getByText("# Hunting")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Inicializar" }));
    fireEvent.click(screen.getByRole("button", { name: "bash / zsh" }));
    const command = () => document.querySelector("[data-install-command]")!.textContent!;
    expect(command()).toContain(
      "git clone --depth 1 https://github.com/cloudflare/security-audit-skill",
    );
    expect(command()).toContain('".claude/skills/security-audit"');
    fireEvent.click(screen.getByRole("button", { name: "Global" }));
    expect(command()).toContain("$HOME/.claude/skills/security-audit");
    fireEvent.click(screen.getByRole("button", { name: "PowerShell" }));
    expect(command()).toContain("Join-Path $HOME '.claude/skills/security-audit'");
    // GitHub skills sync; nobody but an admin removes the built-in one.
    expect(screen.getByRole("button", { name: /Sync from GitHub/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Eliminar/ })).toBeNull();
  });

  it("downloads a skill's zip from its card", async () => {
    const blob = new Blob(["zip"], { type: "application/zip" });
    api.download.mockResolvedValue(blob);
    const createObjectURL = vi.fn(() => "blob:zip");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<SkillsView />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(
      within(screen.getAllByRole("article")[1]!).getByRole("button", { name: /Descargar \.zip/ }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.download).toHaveBeenCalledWith("sk_team");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
  });
});

describe("adding skills", () => {
  it("imports from GitHub: previews the parsed skill, then saves it", async () => {
    const imported = { ...seed, id: "gh_new", slug: "k8s-review", name: "k8s-review" };
    api.importGithub.mockImplementation(async (input) => ({
      skill: imported,
      skipped: input.preview ? ["logo.png"] : [],
      exists: false,
    }));
    render(<SkillsView />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Importar de GitHub/ }));
    const url = screen.getByPlaceholderText("https://github.com/cloudflare/security-audit-skill");
    fireEvent.change(url, { target: { value: "https://github.com/acme/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "Previsualizar" }));
    await waitFor(() => expect(document.querySelector("[data-import-preview]")).toBeTruthy());
    expect(api.importGithub).toHaveBeenLastCalledWith({
      repoUrl: "https://github.com/acme/skills",
      preview: true,
    });
    expect(screen.getByText(/logo\.png/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(document.querySelector("[data-import-save]")!);
    });
    expect(api.importGithub).toHaveBeenLastCalledWith({
      repoUrl: "https://github.com/acme/skills",
    });
    await waitFor(() => expect(cards()).toContain("k8s-review"));
    expect(useChat.getState().toast?.message).toMatch(/k8s-review importada/);
  });

  it("creates a skill with Claude Haiku: the idea fills the SKILL.md, which is saved", async () => {
    const generated = buildSkillMd("cdk-iam-audit", "Audits CDK IAM.", "# Steps\n1. Read policies");
    api.generate.mockResolvedValue({
      name: "cdk-iam-audit",
      description: "Audits CDK IAM.",
      skillMd: generated,
    });
    api.save.mockImplementation(async (input) => ({
      ...team,
      id: "sk_new",
      slug: "cdk-iam-audit",
      name: "cdk-iam-audit",
      category: input.category,
      skillMd: input.skillMd!,
    }));
    render(<SkillsView />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Crear Skill/ }));
    fireEvent.change(document.querySelector("[data-skill-idea]")!, {
      target: { value: "Create a skill to audit AWS CDK IAM permissions" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Generar con IA \(Haiku\)/ }));
    });
    expect(api.generate).toHaveBeenCalledWith("Create a skill to audit AWS CDK IAM permissions");
    expect((document.querySelector("[data-skill-md]") as HTMLTextAreaElement).value).toBe(
      generated,
    );
    expect(screen.getByText("/cdk-iam-audit")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Security" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-skill-save]")!);
    });
    expect(api.save).toHaveBeenCalledWith({ category: "Security", skillMd: generated, files: [] });
    await waitFor(() => expect(cards()).toContain("cdk-iam-audit"));
  });

  it("asks for a name and description when the SKILL.md has no frontmatter", async () => {
    render(<SkillsView />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Crear Skill/ }));
    fireEvent.change(document.querySelector("[data-skill-md]")!, {
      target: { value: "# Just steps" },
    });
    expect(screen.getByText(/Sin frontmatter/)).toBeTruthy();
    const save = document.querySelector("[data-skill-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("cdk-iam-audit"), {
      target: { value: "My Steps" },
    });
    fireEvent.change(screen.getByLabelText(/Descripción/), { target: { value: "Runs my steps." } });
    expect(save.disabled).toBe(false);
  });
});
