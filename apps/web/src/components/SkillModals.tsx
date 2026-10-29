import {
  isSafeSkillPath,
  MAX_SKILL_FILE_BYTES,
  parseFrontmatter,
  SKILL_CATEGORIES,
  toSkillSlug,
  type Skill,
  type SkillCategory,
  type SkillFile,
} from "@mindfultech/shared";
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { CATEGORY_LABELS } from "../lib/skills";
import { skillsApi, type ImportResult } from "../lib/skillsApi";
import { TasksApiError } from "../lib/tasksApi";
import { useChat } from "../store";
import { CloseIcon, GithubIcon, UploadIcon, WandIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { InvocationBadge, OUTLINE_BUTTON, PRIMARY_BUTTON } from "./SkillsView";

export const EXAMPLE_REPO = "https://github.com/cloudflare/security-audit-skill";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-ink placeholder:text-ink-secondary focus:border-primary/60 focus:outline-none";
const LABEL = "flex flex-col gap-1.5 text-sm font-medium text-ink";

const errorText = (err: unknown) =>
  err instanceof TasksApiError || err instanceof Error ? err.message : "Inténtalo de nuevo.";

function CategorySelect({
  value,
  onChange,
  automatic,
}: Readonly<{
  value: SkillCategory | "";
  onChange: (v: SkillCategory | "") => void;
  automatic?: boolean;
}>) {
  return (
    <label className={LABEL}>
      Categoría
      <select
        className={INPUT}
        value={value}
        onChange={(e) => onChange(e.target.value as SkillCategory | "")}
      >
        {automatic && <option value="">Automática (según el skill)</option>}
        {SKILL_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * "Importar de GitHub": a repository URL (or a skill's folder in it), read
 * and previewed, then saved to the catalog. A skill already imported from the
 * same folder is updated (the same as Sync).
 */
export function ImportSkillModal({
  onClose,
  onImported,
}: Readonly<{ onClose: () => void; onImported: (skill: Skill) => void }>) {
  const showToast = useChat((s) => s.showToast);
  const [repoUrl, setRepoUrl] = useState("");
  const [category, setCategory] = useState<SkillCategory | "">("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(previewOnly: boolean) {
    if (!repoUrl.trim()) return;
    setBusy(previewOnly ? "preview" : "import");
    setError(null);
    try {
      const result = await skillsApi.importGithub({
        repoUrl: repoUrl.trim(),
        ...(category && { category }),
        ...(previewOnly && { preview: true }),
      });
      if (previewOnly) setPreview(result);
      else {
        showToast(`${result.skill.name} importada de GitHub`, "success");
        onImported(result.skill);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Importar de GitHub"
      onClose={onClose}
      width="lg"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancelar</SecondaryButton>
          <button
            type="button"
            className={OUTLINE_BUTTON}
            onClick={() => void run(true)}
            disabled={!repoUrl.trim() || !!busy}
          >
            {busy === "preview" ? "Leyendo…" : "Previsualizar"}
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            onClick={() => void run(false)}
            disabled={!repoUrl.trim() || !!busy}
            data-import-save
          >
            <GithubIcon aria-hidden="true" />
            {busy === "import" ? "Importando…" : preview?.exists ? "Actualizar" : "Importar"}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
        <label className={LABEL}>
          URL del repositorio o de la carpeta del skill
          <input
            className={INPUT}
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              setPreview(null);
            }}
            placeholder={EXAMPLE_REPO}
            inputMode="url"
            autoFocus
            data-import-url
          />
          <span className="text-xs font-normal text-ink-secondary">
            Un repositorio con un SKILL.md, o la carpeta de uno (…/tree/main/skills/mi-skill).
          </span>
        </label>
        <CategorySelect value={category} onChange={setCategory} automatic />
        {error && (
          <p
            className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-ink"
            role="alert"
          >
            {error}
          </p>
        )}
        {preview && (
          <section
            className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] p-4"
            data-import-preview
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold">{preview.skill.name}</h3>
              <InvocationBadge slug={preview.skill.slug} />
              {preview.exists && (
                <span className="text-xs text-ink-secondary">
                  Ya está en el catálogo: se actualizará
                </span>
              )}
            </div>
            <p className="text-sm text-ink/80">{preview.skill.description}</p>
            <p className="font-mono text-xs text-ink-secondary">
              {preview.skill.repoPath || "/"} · {preview.skill.repoCommit?.slice(0, 7)} · SKILL.md +{" "}
              {preview.skill.files.length} archivos
            </p>
            {preview.skipped.length > 0 && (
              <p className="text-xs text-warning">
                No se incluyen (binarios o demasiado grandes): {preview.skipped.join(", ")}
              </p>
            )}
          </section>
        )}
      </form>
    </Modal>
  );
}

/**
 * "Crear Skill" (and editing a team skill): write or upload a SKILL.md, or
 * describe an idea and let Claude Haiku 5.5 write it ("Generar con IA");
 * companion files ride along. The SKILL.md's own frontmatter names it; without
 * one, the name and description fields write it.
 */
export function CreateSkillModal({
  editing,
  onClose,
  onSaved,
}: Readonly<{ editing?: Skill; onClose: () => void; onSaved: (skill: Skill) => void }>) {
  const showToast = useChat((s) => s.showToast);
  const [idea, setIdea] = useState("");
  const [skillMd, setSkillMd] = useState(editing?.skillMd ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<SkillCategory | "">(editing?.category ?? "Workflow");
  const [files, setFiles] = useState<SkillFile[]>(editing?.files ?? []);
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mdInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const fm = useMemo(() => (skillMd.trim() ? parseFrontmatter(skillMd) : null), [skillMd]);
  const detectedName = fm?.data.name ? toSkillSlug(fm.data.name) : "";
  const needsFields = !fm?.data.name || !fm.data.description;
  const ready =
    !!category &&
    (detectedName || toSkillSlug(name)) &&
    (fm?.data.description || description.trim()) &&
    !busy;

  async function generate() {
    setBusy("generate");
    setError(null);
    try {
      const generated = await skillsApi.generate(idea.trim());
      setSkillMd(generated.skillMd);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function readMd(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) setSkillMd(await file.text());
  }

  async function addFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = [...(e.target.files ?? [])];
    e.target.value = "";
    const added: SkillFile[] = [];
    for (const file of picked) {
      const path = file.name;
      if (!isSafeSkillPath(path) || file.size > MAX_SKILL_FILE_BYTES) {
        showToast(`${file.name}: nombre no válido o demasiado grande`, "error");
        continue;
      }
      added.push({ path, content: await file.text() });
    }
    setFiles((now) => [...now.filter((f) => !added.some((a) => a.path === f.path)), ...added]);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!ready || !category) return;
    setBusy("save");
    setError(null);
    try {
      const skill = await skillsApi.save({
        ...(editing && { id: editing.id }),
        category,
        ...(skillMd.trim() && { skillMd }),
        ...(needsFields && name.trim() && { name: name.trim() }),
        ...(needsFields && description.trim() && { description: description.trim() }),
        files,
      });
      showToast(editing ? `${skill.name} actualizada` : `${skill.name} creada`, "success");
      onSaved(skill);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  }

  return (
    <Modal
      title={editing ? `Editar ${editing.name}` : "Crear Skill"}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancelar</SecondaryButton>
          <button
            type="submit"
            form="skill-form"
            className={PRIMARY_BUTTON}
            disabled={!ready}
            data-skill-save
          >
            {busy === "save" ? "Guardando…" : editing ? "Guardar cambios" : "Crear skill"}
          </button>
        </>
      }
    >
      <form id="skill-form" className="flex flex-col gap-4" onSubmit={(e) => void save(e)}>
        {!editing && (
          <section className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] p-3">
            <label className={LABEL}>
              Describe la idea
              <textarea
                className={`${INPUT} min-h-[64px]`}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="Crea un skill para auditar los permisos IAM de AWS CDK"
                data-skill-idea
              />
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className={OUTLINE_BUTTON}
                onClick={() => void generate()}
                disabled={idea.trim().length < 10 || !!busy}
                data-skill-generate
              >
                <WandIcon
                  className={busy === "generate" ? "animate-pulse" : ""}
                  aria-hidden="true"
                />
                {busy === "generate" ? "Generando con Claude Haiku…" : "Generar con IA (Haiku)"}
              </button>
              <span className="text-xs text-ink-secondary">
                Rellena el SKILL.md de abajo; revísalo antes de guardar.
              </span>
            </div>
          </section>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">SKILL.md</span>
            <button
              type="button"
              onClick={() => mdInput.current?.click()}
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              <UploadIcon aria-hidden="true" /> Subir SKILL.md
            </button>
            <input
              ref={mdInput}
              type="file"
              accept=".md,text/markdown,text/plain"
              hidden
              onChange={(e) => void readMd(e)}
            />
          </div>
          <textarea
            className={`${INPUT} min-h-[260px] font-mono text-xs leading-relaxed`}
            value={skillMd}
            onChange={(e) => setSkillMd(e.target.value)}
            placeholder={
              "---\nname: mi-skill\ndescription: Qué hace y cuándo usarlo.\n---\n\n# Instrucciones para Claude Code\n"
            }
            spellCheck={false}
            aria-label="SKILL.md"
            data-skill-md
          />
          {fm?.data.name ? (
            <p className="text-xs text-ink-secondary">
              Se llamará <InvocationBadge slug={detectedName} />
              {fm.data.description ? "" : ": falta la descripción en el frontmatter."}
            </p>
          ) : skillMd.trim() ? (
            <p className="text-xs text-warning">
              Sin frontmatter: completa el nombre y la descripción.
            </p>
          ) : null}
        </div>

        {needsFields && (
          <div className="grid gap-3 sm:grid-cols-2">
            {!fm?.data.name && (
              <label className={LABEL}>
                Nombre
                <input
                  className={INPUT}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="cdk-iam-audit"
                />
              </label>
            )}
            {!fm?.data.description && (
              <label className={`${LABEL} sm:col-span-2`}>
                Descripción (qué hace y cuándo usarlo)
                <input
                  className={INPUT}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={1024}
                />
              </label>
            )}
          </div>
        )}

        <CategorySelect value={category} onChange={setCategory} />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Archivos adicionales</span>
            <button
              type="button"
              onClick={() => filesInput.current?.click()}
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              <UploadIcon aria-hidden="true" /> Añadir archivos
            </button>
            <input
              ref={filesInput}
              type="file"
              multiple
              hidden
              onChange={(e) => void addFiles(e)}
            />
          </div>
          {files.length === 0 ? (
            <p className="text-xs text-ink-secondary">
              Scripts o referencias que el SKILL.md menciona (opcional).
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <li
                  key={f.path}
                  className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-2 py-1 font-mono text-xs"
                >
                  {f.path}
                  <button
                    type="button"
                    aria-label={`Quitar ${f.path}`}
                    onClick={() => setFiles((now) => now.filter((x) => x.path !== f.path))}
                    className="text-ink-secondary hover:text-ink"
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p
            className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-ink"
            role="alert"
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
