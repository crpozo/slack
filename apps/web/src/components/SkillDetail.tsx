import {
  installCommand,
  parseFrontmatter,
  skillBundle,
  skillDir,
  type Skill,
  type SkillScope,
  type SkillShell,
} from "@mindfultech/shared";
import { useEffect, useMemo, useState } from "react";
import { renderNotesMarkdown } from "../lib/markdown";
import {
  canChangeSkill,
  canInstallInDesktop,
  CATEGORY_LABELS,
  defaultShell,
  installInDesktop,
  saveBlob,
} from "../lib/skills";
import { skillsApi } from "../lib/skillsApi";
import { TasksApiError } from "../lib/tasksApi";
import { useChat } from "../store";
import { useSkills } from "../store/skills";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  PencilIcon,
  RefreshIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";
import { useModalDialog } from "./Modal";
import { InvocationBadge, OUTLINE_BUTTON, PRIMARY_BUTTON, SourceBadge } from "./SkillsView";

export type DetailTab = "preview" | "files" | "install";

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "preview", label: "Vista previa" },
  { id: "files", label: "Archivos" },
  { id: "install", label: "Inicializar" },
];

const errorText = (err: unknown) =>
  err instanceof TasksApiError || err instanceof Error ? err.message : "inténtalo de nuevo";

const SEGMENT =
  "h-8 rounded-lg px-3 text-xs font-semibold transition aria-pressed:bg-primary/20 aria-pressed:text-[#8fe0b0] text-ink-secondary hover:text-ink";

/**
 * One skill, in a drawer: its SKILL.md rendered, every file to read, and
 * how to put it in Claude Code (a command to copy, a download, or the
 * desktop app's one-click install). Its author (or an admin) edits or
 * removes it; a GitHub skill can be synced with its repository.
 */
export function SkillDetail({
  skillId,
  initialTab = "preview",
  onClose,
  onEdit,
}: Readonly<{
  skillId: string;
  initialTab?: DetailTab;
  onClose: () => void;
  onEdit: (skill: Skill) => void;
}>) {
  const dialog = useModalDialog(onClose);
  const loadDetail = useSkills((s) => s.loadDetail);
  const cached = useSkills((s) => s.details[skillId]);
  const summary = useSkills((s) => s.skills.find((x) => x.id === skillId));
  const { put, drop } = useSkills();
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sync" | "delete" | "zip" | "install" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    loadDetail(skillId).catch((err: unknown) => setError(errorText(err)));
  }, [loadDetail, skillId]);

  const skill = cached;
  const header = skill ?? summary;

  async function sync() {
    if (!skill?.repoUrl) return;
    setBusy("sync");
    const url = skill.repoPath
      ? `${skill.repoUrl}/tree/${skill.repoRef ?? "HEAD"}/${skill.repoPath}`
      : skill.repoUrl;
    try {
      const { skill: synced } = await skillsApi.importGithub({ repoUrl: url });
      put(synced);
      showToast(`Sincronizada con GitHub (${synced.repoCommit?.slice(0, 7)})`, "success");
    } catch (err) {
      showToast(`No se pudo sincronizar: ${errorText(err)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await skillsApi.remove(skillId);
      drop(skillId);
      showToast(`${header?.name ?? "Skill"} eliminada del catálogo`, "success");
      onClose();
    } catch (err) {
      showToast(`No se pudo eliminar: ${errorText(err)}`, "error");
      setBusy(null);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label={header ? `Skill ${header.name}` : "Skill"}
      className="fixed inset-y-0 left-auto right-0 m-0 h-full max-h-none w-full max-w-3xl overflow-hidden border-l border-white/10 p-0 text-ink glass-strong backdrop:bg-scrim/50 backdrop:backdrop-blur-sm"
      data-skill-detail
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 flex-col gap-3 border-b border-white/10 p-5">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h2 className="truncate text-xl font-bold">{header?.name ?? "…"}</h2>
              {header && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <InvocationBadge slug={header.slug} />
                  <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-ink-secondary">
                    {CATEGORY_LABELS[header.category]}
                  </span>
                  <SourceBadge skill={header} />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="rounded-md p-1.5 text-ink-secondary hover:bg-white/10 hover:text-ink"
            >
              <CloseIcon />
            </button>
          </div>
          {header && <p className="text-sm leading-relaxed text-ink/75">{header.description}</p>}
          {skill && (
            <div className="flex flex-wrap gap-2">
              {skill.sourceType === "github" && (
                <button
                  type="button"
                  className={OUTLINE_BUTTON}
                  onClick={() => void sync()}
                  disabled={!!busy}
                >
                  <RefreshIcon
                    className={busy === "sync" ? "animate-spin" : ""}
                    aria-hidden="true"
                  />
                  {busy === "sync" ? "Sincronizando…" : "Sync from GitHub"}
                </button>
              )}
              {skill.sourceType === "team" && canChangeSkill(skill, me) && (
                <button type="button" className={OUTLINE_BUTTON} onClick={() => onEdit(skill)}>
                  <PencilIcon aria-hidden="true" /> Editar
                </button>
              )}
              {canChangeSkill(skill, me) &&
                (confirmDelete ? (
                  <span className="flex items-center gap-2 text-sm">
                    ¿Eliminar del catálogo?
                    <button
                      type="button"
                      className="rounded-lg bg-error px-3 py-1.5 text-xs font-semibold text-white"
                      onClick={() => void remove()}
                      disabled={busy === "delete"}
                    >
                      Sí, eliminar
                    </button>
                    <button
                      type="button"
                      className="text-xs text-ink-secondary"
                      onClick={() => setConfirmDelete(false)}
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="inline-flex h-10 items-center gap-2 rounded-[10px] px-3 text-[13px] text-ink-secondary hover:bg-error/15 hover:text-error"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <TrashIcon aria-hidden="true" /> Eliminar
                  </button>
                ))}
            </div>
          )}
          <nav className="flex gap-1" role="tablist" aria-label="Secciones">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`h-9 rounded-lg px-3 text-sm font-semibold transition ${
                  tab === t.id
                    ? "bg-primary/20 text-[#8fe0b0]"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5" role="tabpanel">
          {error && !skill ? (
            <p className="text-sm text-warning">No se pudo abrir: {error}</p>
          ) : !skill ? (
            <div className="space-y-3" aria-busy="true" aria-label="Cargando">
              <div className="h-4 w-2/3 animate-pulse rounded bg-white/10" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-white/10" />
            </div>
          ) : tab === "preview" ? (
            <Preview skill={skill} />
          ) : tab === "files" ? (
            <Files skill={skill} />
          ) : (
            <Install skill={skill} busy={busy} setBusy={setBusy} />
          )}
        </div>
      </div>
    </dialog>
  );
}

function Preview({ skill }: Readonly<{ skill: Skill }>) {
  const fm = useMemo(() => parseFrontmatter(skill.skillMd), [skill.skillMd]);
  const html = useMemo(() => renderNotesMarkdown(fm?.body ?? skill.skillMd), [fm, skill.skillMd]);
  return (
    <div className="flex flex-col gap-4" data-skill-preview>
      {fm && (
        <dl className="grid gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs sm:grid-cols-[auto_1fr]">
          {Object.entries(fm.data).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-ink-secondary">{key}</dt>
              <dd className="whitespace-pre-wrap break-words text-ink/85">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div
        className="md md-notes break-words text-sm leading-relaxed text-ink"
        // The notes renderer escapes everything; only its own markup comes through.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function Files({ skill }: Readonly<{ skill: Skill }>) {
  const files = useMemo(() => skillBundle(skill), [skill]);
  const [path, setPath] = useState("SKILL.md");
  const file = files.find((f) => f.path === path) ?? files[0]!;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3 md:flex-row" data-skill-files>
      <ul className="flex shrink-0 flex-col gap-0.5 md:w-56">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setPath(f.path)}
              aria-current={f.path === file.path}
              className={`flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left font-mono text-xs ${
                f.path === file.path
                  ? "bg-primary/15 text-ink"
                  : "text-ink-secondary hover:bg-white/[0.06] hover:text-ink"
              }`}
              title={f.path}
            >
              <FileIcon className="shrink-0" aria-hidden="true" />
              <span className="truncate">{f.path}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(file.content).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
          className="absolute right-2 top-2 rounded-md bg-white/10 p-1.5 text-ink-secondary hover:text-ink"
          aria-label={copied ? "Copiado" : `Copiar ${file.path}`}
        >
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
        </button>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/30 p-3 pr-10 font-mono text-xs leading-relaxed text-ink/85">
          {file.content}
        </pre>
      </div>
    </div>
  );
}

function Install({
  skill,
  busy,
  setBusy,
}: Readonly<{
  skill: Skill;
  busy: string | null;
  setBusy: (b: "install" | "zip" | null) => void;
}>) {
  const showToast = useChat((s) => s.showToast);
  const [scope, setScope] = useState<SkillScope>("project");
  const [shell, setShell] = useState<SkillShell>(defaultShell);
  const [copied, setCopied] = useState(false);
  const command = installCommand(skill, scope, shell);
  const desktop = canInstallInDesktop();

  async function installHere() {
    setBusy("install");
    try {
      await installInDesktop(skill);
      showToast(`Instalada en ~/.claude/skills/${skill.slug}`, "success");
    } catch (err) {
      showToast(`No se pudo instalar: ${errorText(err)}. Usa el comando o la descarga.`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function zip() {
    setBusy("zip");
    try {
      saveBlob(await skillsApi.download(skill.id), `${skill.slug}.zip`);
    } catch (err) {
      showToast(`No se pudo descargar: ${errorText(err)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-skill-install>
      {desktop && (
        <section className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/[0.08] p-4">
          <h3 className="text-sm font-bold">Instalar con un clic</h3>
          <p className="text-xs text-ink-secondary">
            La app de escritorio escribe el skill en <code>~/.claude/skills/{skill.slug}/</code>:
            Claude Code lo usa en todos tus proyectos.
          </p>
          <div>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => void installHere()}
              disabled={busy === "install"}
            >
              <DownloadIcon aria-hidden="true" />
              {busy === "install" ? "Instalando…" : "Instalar en este equipo"}
            </button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <TerminalIcon aria-hidden="true" /> Inicializar en Terminal
        </h3>
        <div className="flex flex-wrap gap-3">
          <div
            className="flex rounded-xl border border-white/10 bg-black/20 p-1"
            role="group"
            aria-label="Dónde"
          >
            <button
              type="button"
              className={SEGMENT}
              aria-pressed={scope === "project"}
              onClick={() => setScope("project")}
            >
              Proyecto
            </button>
            <button
              type="button"
              className={SEGMENT}
              aria-pressed={scope === "global"}
              onClick={() => setScope("global")}
            >
              Global
            </button>
          </div>
          <div
            className="flex rounded-xl border border-white/10 bg-black/20 p-1"
            role="group"
            aria-label="Terminal"
          >
            <button
              type="button"
              className={SEGMENT}
              aria-pressed={shell === "bash"}
              onClick={() => setShell("bash")}
            >
              bash / zsh
            </button>
            <button
              type="button"
              className={SEGMENT}
              aria-pressed={shell === "powershell"}
              onClick={() => setShell("powershell")}
            >
              PowerShell
            </button>
          </div>
        </div>
        <p className="text-xs text-ink-secondary">
          Lo deja en <code className="text-ink/85">{skillDir(skill.slug, scope)}/</code>
          {scope === "project"
            ? " (ejecútalo en la raíz del proyecto)."
            : " (para todos tus proyectos)."}
          {skill.sourceType === "github" ? " Necesita git." : ""}
        </p>
        {command ? (
          <div className="relative">
            <pre
              className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-white/10 bg-black/40 p-3 pr-24 font-mono text-xs leading-relaxed text-[#b6f0cd]"
              data-install-command
            >
              {command}
            </pre>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(command).then(() => {
                  setCopied(true);
                  showToast("Comando copiado", "success");
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-[#0E0D12]"
            >
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
        ) : (
          <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-ink">
            Este skill no se puede escribir en línea con PowerShell. Descárgalo y descomprímelo en{" "}
            <code>{skillDir(skill.slug, scope)}</code>.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-bold">Descargar</h3>
        <p className="text-xs text-ink-secondary">
          El .zip trae la carpeta <code>{skill.slug}/</code>: descomprímela en{" "}
          <code>.claude/skills/</code>.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={OUTLINE_BUTTON}
            onClick={() => void zip()}
            disabled={busy === "zip"}
          >
            <DownloadIcon aria-hidden="true" /> Descargar .zip
          </button>
          <button
            type="button"
            className={OUTLINE_BUTTON}
            onClick={() =>
              saveBlob(new Blob([skill.skillMd], { type: "text/markdown" }), "SKILL.md")
            }
          >
            <FileIcon aria-hidden="true" /> SKILL.md
          </button>
        </div>
      </section>
    </div>
  );
}
