import type { SkillCategory } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// Recommended skills (Phase 61): a short list of well-known public skills,
// one click away in AI Skills. Two sources, their folders checked on
// 2026-11-11: Anthropic's own repository (`anthropics/skills`) and
// `obra/superpowers`, a widely used set of engineering-workflow skills.
// Only skills checked to fit the importer whole are listed (the limits were
// raised for claude-api, the largest: 96 files, 2.1 MB). Nothing is bundled: Import reads the folder from GitHub at that moment, so
// what lands in the catalog is the latest version (and "Sync" refreshes it).
// ---------------------------------------------------------------------------

export interface RecommendedSkill {
  /** The folder's name: the skill's slug once imported. */
  slug: string;
  /** What it's for, in a line (Spanish, as the catalog reads). */
  about: string;
  category: SkillCategory;
  source: "Anthropic" | "Superpowers";
  /** The skill's folder on GitHub. */
  url: string;
}

const anthropic = (slug: string, category: SkillCategory, about: string): RecommendedSkill => ({
  slug,
  about,
  category,
  source: "Anthropic",
  url: `https://github.com/anthropics/skills/tree/main/skills/${slug}`,
});
const superpowers = (slug: string, about: string): RecommendedSkill => ({
  slug,
  about,
  category: "Workflow",
  source: "Superpowers",
  url: `https://github.com/obra/superpowers/tree/main/skills/${slug}`,
});

export const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  anthropic(
    "claude-api",
    "Backend",
    "Para construir agentes de IA: uso de herramientas, flujos definidos, Managed Agents y computer use (operar sistemas como una persona).",
  ),
  anthropic("skill-creator", "Workflow", "Crea, mejora y evalúa skills nuevas paso a paso."),
  anthropic(
    "frontend-design",
    "Frontend",
    "Interfaces con diseño cuidado, lejos del aspecto genérico de IA.",
  ),
  anthropic(
    "webapp-testing",
    "Frontend",
    "Prueba apps web locales con Playwright: flujos, capturas y logs.",
  ),
  anthropic(
    "mcp-builder",
    "Backend",
    "Guía para construir servidores MCP de calidad (herramientas para agentes).",
  ),
  anthropic("pdf", "Data", "Lee, extrae tablas, une, divide y crea PDF; rellena formularios."),
  anthropic(
    "doc-coauthoring",
    "Workflow",
    "Flujo para escribir documentos y specs en conjunto, por etapas.",
  ),
  superpowers(
    "test-driven-development",
    "TDD estricto: la prueba que falla primero, luego el código mínimo.",
  ),
  superpowers(
    "systematic-debugging",
    "Depuración por causa raíz en fases, antes de tocar una sola línea.",
  ),
  superpowers("brainstorming", "Convierte una idea vaga en un diseño acordado antes de programar."),
  superpowers("writing-plans", "Planes de implementación en tareas pequeñas y verificables."),
  superpowers("executing-plans", "Ejecuta un plan por lotes, con puntos de revisión."),
  superpowers(
    "verification-before-completion",
    "No dar nada por terminado sin evidencia: correr y comprobar antes de afirmar.",
  ),
  superpowers(
    "requesting-code-review",
    "Pide una revisión de código con el contexto correcto antes de fusionar.",
  ),
  superpowers("using-git-worktrees", "Trabajo aislado por rama con git worktrees."),
  superpowers("subagent-driven-development", "Un subagente por tarea, con revisión entre tareas."),
  superpowers(
    "dispatching-parallel-agents",
    "Reparte problemas independientes entre agentes en paralelo.",
  ),
  superpowers(
    "receiving-code-review",
    "Cómo responder a una revisión: verificar antes de aceptar o discutir.",
  ),
  superpowers(
    "finishing-a-development-branch",
    "Cierra una rama: pruebas, opciones de merge o PR, y limpieza.",
  ),
  superpowers("writing-skills", "Escribe skills probándolas primero, como si fuera TDD."),
];

/** The recommended skills not in the catalog yet (by slug). */
export function missingRecommended(have: ReadonlyArray<{ slug: string }>): RecommendedSkill[] {
  const slugs = new Set(have.map((s) => s.slug));
  return RECOMMENDED_SKILLS.filter((r) => !slugs.has(r.slug));
}
