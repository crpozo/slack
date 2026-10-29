import type { Skill, SkillSummary } from "@mindfultech/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import {
  canInstallInDesktop,
  CATEGORY_LABELS,
  filterSkills,
  installInDesktop,
  repoLabel,
  saveBlob,
  SKILL_FILTERS,
  type SkillFilter,
} from "../lib/skills";
import { skillsApi } from "../lib/skillsApi";
import { tasksApiConfigured, TasksApiError } from "../lib/tasksApi";
import { useChat } from "../store";
import { useSkills } from "../store/skills";
import {
  DownloadIcon,
  GithubIcon,
  MenuIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  TerminalIcon,
} from "./icons";
import { SkillDetail, type DetailTab } from "./SkillDetail";
import { CreateSkillModal, ImportSkillModal } from "./SkillModals";
import { UnreadAlertsDot } from "./NotificationBell";

export const GLASS_CARD =
  "rounded-[18px] border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.035] shadow-[0_14px_40px_rgb(0_0_0/0.3),inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-xl";
export const PRIMARY_BUTTON =
  "inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] bg-primary px-4 text-[13px] font-semibold text-[#0E0D12] shadow-[0_0_24px_rgb(64_179_117/0.25)] transition hover:bg-[#4fc485] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60";
export const OUTLINE_BUTTON =
  "inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border border-primary/50 bg-primary/[0.06] px-4 text-[13px] font-semibold text-[#6fcf97] backdrop-blur-md transition hover:border-primary hover:bg-primary/[0.14] hover:text-[#8fe0b0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";
const QUICK_ACTION =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-xs font-medium text-ink/85 transition hover:border-primary/50 hover:bg-primary/[0.08] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";

const errorText = (err: unknown, fallback: string) =>
  err instanceof TasksApiError || err instanceof Error ? err.message || fallback : fallback;

/** "/security-audit": how the skill is called in Claude Code. */
export function InvocationBadge({ slug }: Readonly<{ slug: string }>) {
  return (
    <span className="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-[#6fcf97]">
      /{slug}
    </span>
  );
}

/** GitHub (with its repository) or MindfulTech (with its author). */
export function SourceBadge({
  skill,
}: Readonly<{ skill: Pick<SkillSummary, "sourceType" | "repoUrl" | "authorName"> }>) {
  if (skill.sourceType === "github" && skill.repoUrl) {
    return (
      <a
        href={skill.repoUrl}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDesktopApp()) return; // a new tab by itself
          e.preventDefault();
          void openExternal(skill.repoUrl!);
        }}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex min-w-0 items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-ink-secondary hover:text-ink"
        title={`GitHub: ${repoLabel(skill.repoUrl)}`}
        data-source="github"
      >
        <GithubIcon className="shrink-0" aria-hidden="true" />
        <span className="truncate">{repoLabel(skill.repoUrl)}</span>
      </a>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-md bg-primary/[0.12] px-1.5 py-0.5 text-[11px] text-[#6fcf97]"
      title={`MindfulTech · ${skill.authorName}`}
      data-source="team"
    >
      <span className="font-semibold">MindfulTech</span>
      <span className="truncate text-ink-secondary">· {skill.authorName}</span>
    </span>
  );
}

/**
 * AI Skills (`/app/skills`, Phase 44): the team's catalog of Claude Code
 * skills. Search and filters, a card per skill with its quick actions, the
 * detail drawer (preview, files, install commands), and the GitHub import
 * and create modals.
 */
export function SkillsView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const { status, skills, error, load, loadDetail, put } = useSkills();
  const showToast = useChat((s) => s.showToast);
  const configured = tasksApiConfigured();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [open, setOpen] = useState<{ id: string; tab: DetailTab } | null>(null);
  const [modal, setModal] = useState<"import" | "create" | { edit: Skill } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    document.title = "AI Skills · MindfulTech";
    if (configured) void load();
  }, [configured, load]);

  const shown = useMemo(() => filterSkills(skills, query, filter), [skills, query, filter]);

  async function download(skill: SkillSummary) {
    setBusy(`zip:${skill.id}`);
    try {
      saveBlob(await skillsApi.download(skill.id), `${skill.slug}.zip`);
    } catch (err) {
      showToast(`No se pudo descargar: ${errorText(err, "inténtalo de nuevo")}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function install(skill: SkillSummary) {
    if (!canInstallInDesktop()) {
      setOpen({ id: skill.id, tab: "install" });
      return;
    }
    setBusy(`install:${skill.id}`);
    try {
      await installInDesktop(await loadDetail(skill.id));
      showToast(`Instalada en ~/.claude/skills/${skill.slug}`, "success");
    } catch (err) {
      showToast(`No se pudo instalar: ${errorText(err, "inténtalo de nuevo")}`, "error");
      setOpen({ id: skill.id, tab: "install" });
    } finally {
      setBusy(null);
    }
  }

  const menu = onOpenSidebar && (
    <button
      type="button"
      onClick={onOpenSidebar}
      className="relative -ml-1 rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
      aria-label="Open menu"
    >
      <MenuIcon />
      <UnreadAlertsDot />
    </button>
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col bg-surface bg-[radial-gradient(900px_420px_at_15%_-10%,rgb(64_179_117/0.16),transparent_60%),radial-gradient(700px_400px_at_100%_10%,rgb(64_179_117/0.07),transparent_60%)]"
      data-skills-view
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-3">
                {menu}
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_4px_rgb(64_179_117/0.18),0_0_18px_rgb(64_179_117/0.6)]"
                  aria-hidden="true"
                />
                <h1 className="text-[32px] font-extrabold leading-tight tracking-tight text-ink">
                  AI Skills
                </h1>
              </div>
              <p className="text-sm text-ink-secondary">
                Catálogo de skills de Claude Code del equipo y la comunidad
              </p>
            </div>
            {configured && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={OUTLINE_BUTTON} onClick={() => setModal("import")}>
                  <GithubIcon aria-hidden="true" /> Importar de GitHub
                </button>
                <button type="button" className={PRIMARY_BUTTON} onClick={() => setModal("create")}>
                  <PlusIcon aria-hidden="true" /> Crear Skill
                </button>
              </div>
            )}
          </header>

          {!configured ? (
            <Notice>AI Skills isn&apos;t set up on this deployment.</Notice>
          ) : (
            <>
              <div className={`${GLASS_CARD} flex flex-col gap-3 p-3 sm:flex-row sm:items-center`}>
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 focus-within:border-primary/60">
                  <SearchIcon className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Buscar por nombre, comando o descripción…"
                    aria-label="Buscar skills"
                    className="h-10 w-full bg-transparent text-sm text-ink placeholder:text-ink-secondary focus:outline-none"
                    data-skills-search
                  />
                </label>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar skills">
                  {SKILL_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      className={`h-8 rounded-full border px-3 text-xs font-semibold transition ${
                        filter === f.id
                          ? "border-primary bg-primary/20 text-[#8fe0b0]"
                          : "border-white/10 bg-white/[0.04] text-ink-secondary hover:border-white/25 hover:text-ink"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && status === "ready" && (
                <p className="text-sm text-warning" role="status">
                  {error}
                </p>
              )}

              {status === "error" ? (
                <Notice>
                  {error}{" "}
                  <button
                    type="button"
                    className="font-semibold text-primary"
                    onClick={() => void load(true)}
                  >
                    Reintentar
                  </button>
                </Notice>
              ) : status !== "ready" ? (
                <ul
                  className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                  aria-busy="true"
                  aria-label="Cargando skills"
                >
                  {[0, 1, 2].map((i) => (
                    <li key={i} className={`${GLASS_CARD} h-56 animate-pulse`} />
                  ))}
                </ul>
              ) : shown.length === 0 ? (
                <Notice>
                  {skills.length === 0
                    ? "Aún no hay skills. Importa uno de GitHub o crea el primero."
                    : "Ningún skill coincide con la búsqueda."}
                </Notice>
              ) : (
                <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-skills-grid>
                  {shown.map((skill) => (
                    <li key={skill.id} className="flex">
                      <SkillCard
                        skill={skill}
                        busy={busy}
                        onOpen={() => setOpen({ id: skill.id, tab: "preview" })}
                        onInstall={() => void install(skill)}
                        onDownload={() => void download(skill)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      {open && (
        <SkillDetail
          skillId={open.id}
          initialTab={open.tab}
          onClose={() => setOpen(null)}
          onEdit={(skill) => {
            setOpen(null);
            setModal({ edit: skill });
          }}
        />
      )}
      {modal === "import" && (
        <ImportSkillModal
          onClose={() => setModal(null)}
          onImported={(skill) => {
            put(skill);
            setModal(null);
            setOpen({ id: skill.id, tab: "preview" });
          }}
        />
      )}
      {(modal === "create" || (modal && typeof modal === "object")) && (
        <CreateSkillModal
          editing={typeof modal === "object" && modal ? modal.edit : undefined}
          onClose={() => setModal(null)}
          onSaved={(skill) => {
            put(skill);
            setModal(null);
            setOpen({ id: skill.id, tab: "preview" });
          }}
        />
      )}
    </div>
  );
}

function SkillCard({
  skill,
  busy,
  onOpen,
  onInstall,
  onDownload,
}: Readonly<{
  skill: SkillSummary;
  busy: string | null;
  onOpen: () => void;
  onInstall: () => void;
  onDownload: () => void;
}>) {
  return (
    <article
      className={`${GLASS_CARD} group flex w-full flex-col gap-3 p-5 transition hover:border-primary/40`}
      data-skill-card={skill.slug}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 text-lg text-primary"
          aria-hidden="true"
        >
          {skill.sourceType === "github" ? <GithubIcon /> : <PuzzleIcon />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="truncate text-base font-bold text-ink">
            <button type="button" onClick={onOpen} className="text-left hover:underline">
              {skill.name}
            </button>
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <InvocationBadge slug={skill.slug} />
            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-ink-secondary">
              {CATEGORY_LABELS[skill.category]}
            </span>
          </div>
        </div>
      </div>
      <SourceBadge skill={skill} />
      <p className="line-clamp-3 flex-1 text-sm leading-relaxed text-ink/75">{skill.description}</p>
      <p className="text-[11px] text-ink-secondary">
        SKILL.md
        {skill.files.length > 0 &&
          ` + ${skill.files.length} ${skill.files.length === 1 ? "archivo" : "archivos"}`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={`${QUICK_ACTION} border-primary/40 text-[#6fcf97]`}
          onClick={onInstall}
          disabled={busy === `install:${skill.id}`}
        >
          <TerminalIcon aria-hidden="true" />
          {busy === `install:${skill.id}` ? "Instalando…" : "Inicializar / Instalar"}
        </button>
        <button
          type="button"
          className={QUICK_ACTION}
          onClick={onDownload}
          disabled={busy === `zip:${skill.id}`}
        >
          <DownloadIcon aria-hidden="true" /> Descargar .zip
        </button>
        <button type="button" className={QUICK_ACTION} onClick={onOpen}>
          Ver detalle
        </button>
      </div>
    </article>
  );
}

function Notice({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      className={`${GLASS_CARD} px-6 py-10 text-center text-sm text-ink-secondary`}
      role="status"
    >
      {children}
    </div>
  );
}
