import {
  CRM_FIELD_LABEL,
  FORECAST_LABEL,
  SALES_FLOW_LABEL,
  SALES_ITEM_LABEL,
  SALES_STAGE_LABEL,
  salesLabel,
  type SalesAiInput,
  type SalesArtifact,
  type SalesFlow,
  type SalesItem,
  type SalesRecord,
  type SalesSlide,
} from "@mindfultech/shared";
import { useMemo, useState } from "react";
import { downloadPptx } from "../../lib/pptx";
import { useChat } from "../../store";
import { artifactOf, useSales } from "../../store/sales";
import { Modal, SecondaryButton } from "../Modal";
import { Badge, DemoTag, fmtDay, SmallButton, useSalesNav } from "./ui";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): what the assistant wrote, shown the same way for every
// flow. Each point says what it is (a documented fact, a hypothesis, an exact
// quote, a paraphrase…) and links to the records behind it; drafts are edited
// here before anyone sends them; a CRM change is listed exactly and applied
// only when the rep confirms it.
// ---------------------------------------------------------------------------

const KIND_TONE: Record<SalesItem["kind"], "good" | "warn" | "bad" | "info" | "neutral"> = {
  hecho: "good",
  hipotesis: "warn",
  pendiente: "bad",
  accion: "info",
  cita: "good",
  parafrasis: "neutral",
};

function Sources({ ids, records }: Readonly<{ ids: string[]; records: SalesRecord[] }>) {
  const nav = useSalesNav();
  if (ids.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {ids.map((id) => {
        const r = records.find((x) => x.id === id);
        if (!r) return null;
        const date = "date" in r ? r.date : r.sourceDate;
        return (
          <button
            key={id}
            type="button"
            onClick={() => nav.open(r as SalesRecord & { accountId?: string })}
            className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-secondary hover:border-primary/60 hover:text-ink"
            title={`Abrir la fuente (${id})`}
          >
            ↗ {salesLabel(r)}
            {date ? ` · ${fmtDay(date.slice(0, 10))}` : ""}
          </button>
        );
      })}
    </span>
  );
}

/** The value of a CRM field as a person reads it. */
export const crmValue = (field: string, value: string): string =>
  field === "stage"
    ? (SALES_STAGE_LABEL[value as keyof typeof SALES_STAGE_LABEL] ?? value)
    : field === "forecastCategory"
      ? (FORECAST_LABEL[value as keyof typeof FORECAST_LABEL] ?? value)
      : value || "(vacío)";

/** A deck, edited in place and exported to PowerPoint. */
export function SlidesEditor({ name, initial }: Readonly<{ name: string; initial: SalesSlide[] }>) {
  const [slides, setSlides] = useState(initial);
  const patch = (i: number, change: Partial<SalesSlide>) =>
    setSlides((all) => all.map((s, at) => (at === i ? { ...s, ...change } : s)));
  return (
    <div className="space-y-2" data-sales-slides>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">
          Presentación · {slides.length} diapositivas (editable)
        </p>
        <SmallButton primary onClick={() => downloadPptx(name, slides)}>
          Exportar a PowerPoint
        </SmallButton>
      </div>
      <ol className="space-y-2">
        {slides.map((s, i) => (
          <li key={i} className="rounded-lg border border-line p-2.5">
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-xs tabular-nums text-ink-secondary">{i + 1}</span>
              <input
                value={s.title}
                onChange={(e) => patch(i, { title: e.target.value })}
                aria-label={`Título de la diapositiva ${i + 1}`}
                className="input min-w-0 flex-1 font-semibold"
              />
            </div>
            {(s.bullets.length > 0 || !s.table) && (
              <textarea
                value={s.bullets.join("\n")}
                onChange={(e) => patch(i, { bullets: e.target.value.split("\n") })}
                rows={Math.max(2, s.bullets.length)}
                aria-label={`Viñetas de la diapositiva ${i + 1}`}
                className="input mt-1.5 w-full text-sm"
              />
            )}
            {s.table && (
              <div className="mt-1.5 overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {s.table.map((row, r) => (
                      <tr
                        key={r}
                        className={r === 0 ? "font-semibold text-ink" : "text-ink-secondary"}
                      >
                        {row.map((cell, c) => (
                          <td key={c} className="border border-line px-1.5 py-1 tabular-nums">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {s.notes && <p className="mt-1 text-xs text-ink-secondary">Notas: {s.notes}</p>}
          </li>
        ))}
      </ol>
      <p className="text-xs text-ink-secondary">
        El archivo .pptx se abre en PowerPoint y Keynote, y se importa en Google Slides (Archivo →
        Importar diapositivas).
      </p>
    </div>
  );
}

function CrmProposal({ artifact }: Readonly<{ artifact: SalesArtifact }>) {
  const records = useSales((s) => s.state?.records ?? []);
  const applyCrm = useSales((s) => s.applyCrm);
  const showToast = useChat((s) => s.showToast);
  const updates = artifact.result.crmUpdates;
  const [picked, setPicked] = useState(() => updates.map(() => true));
  const [values, setValues] = useState(() => updates.map((u) => u.value));
  const [busy, setBusy] = useState(false);
  // One key per proposal as reviewed: pressing twice, or a retry after a lost answer, applies once.
  const key = useMemo(
    () => `crm-${artifact.id.slice(-12)}-${artifact.updatedAt.toString(36)}`,
    [artifact.id, artifact.updatedAt],
  );
  const current = (recordId: string, field: string) =>
    String(
      (records.find((r) => r.id === recordId) as Record<string, unknown> | undefined)?.[field] ??
        "",
    );
  const pending = updates
    .map((u, i) => ({ ...u, value: values[i] ?? u.value, on: picked[i] }))
    .filter((u) => u.on && current(u.recordId, u.field) !== u.value);

  async function confirm() {
    setBusy(true);
    try {
      const done = await applyCrm(
        key,
        pending.map(({ recordId, field, value }) => ({ recordId, field, value })),
      );
      showToast(
        done.repeated
          ? "Esos cambios ya estaban aplicados: no se duplicó nada."
          : `CRM actualizado: ${done.applied.length} ${done.applied.length === 1 ? "cambio" : "cambios"}.`,
        "success",
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo actualizar el CRM.", "error");
    }
    setBusy(false);
  }

  return (
    <div
      className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3"
      data-crm-proposal
    >
      <p className="text-sm font-semibold text-ink">Actualización propuesta del CRM</p>
      <p className="text-xs text-ink-secondary">
        Nada se ha guardado. Revisa cada cambio, edita el valor si hace falta y confirma.
      </p>
      <ul className="space-y-2">
        {updates.map((u, i) => {
          const record = records.find((r) => r.id === u.recordId);
          const from = current(u.recordId, u.field);
          const done = from === (values[i] ?? u.value);
          return (
            <li
              key={`${u.recordId}-${u.field}`}
              className="rounded-lg border border-line bg-surface/70 p-2"
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked[i] && !done}
                  disabled={done}
                  onChange={(e) =>
                    setPicked((p) => p.map((v, at) => (at === i ? e.target.checked : v)))
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                    <strong>{CRM_FIELD_LABEL[u.field] ?? u.field}</strong>
                    <span className="text-ink-secondary">
                      en {record ? salesLabel(record) : u.recordId}
                    </span>
                    {done && <Badge tone="good">Aplicado</Badge>}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="rounded bg-error/10 px-1.5 py-0.5 text-ink-secondary line-through">
                      {crmValue(u.field, from)}
                    </span>
                    <span aria-hidden="true">→</span>
                    {u.field === "stage" || u.field === "forecastCategory" ? (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
                        {crmValue(u.field, values[i] ?? u.value)}
                      </span>
                    ) : (
                      <input
                        value={values[i] ?? ""}
                        onChange={(e) =>
                          setValues((v) => v.map((x, at) => (at === i ? e.target.value : x)))
                        }
                        aria-label={`Nuevo valor de ${CRM_FIELD_LABEL[u.field] ?? u.field}`}
                        className="input min-w-0 flex-1 py-0.5 text-xs"
                      />
                    )}
                  </span>
                  {u.reason && (
                    <span className="mt-1 block text-xs text-ink-secondary">{u.reason}</span>
                  )}
                  <Sources ids={u.sources} records={records} />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn-primary"
        disabled={busy || pending.length === 0}
        onClick={() => void confirm()}
      >
        {busy
          ? "Aplicando…"
          : pending.length === 0
            ? "Sin cambios por aplicar"
            : `Confirmar y aplicar ${pending.length} ${pending.length === 1 ? "cambio" : "cambios"}`}
      </button>
    </div>
  );
}

function Draft({ artifact }: Readonly<{ artifact: SalesArtifact }>) {
  const showToast = useChat((s) => s.showToast);
  const [subject, setSubject] = useState(artifact.result.draft.subject);
  const [body, setBody] = useState(artifact.result.draft.body);
  return (
    <div className="space-y-1.5 rounded-xl border border-line p-3" data-sales-draft>
      <p className="text-sm font-semibold text-ink">Borrador (edítalo antes de enviar)</p>
      {subject !== "" && (
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-label="Asunto"
          className="input w-full"
        />
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(14, Math.max(5, body.split("\n").length + 1))}
        aria-label="Mensaje"
        className="input w-full text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <SmallButton
          onClick={() =>
            void navigator.clipboard
              .writeText(subject ? `${subject}\n\n${body}` : body)
              .then(() => showToast("Borrador copiado", "success"))
          }
        >
          Copiar
        </SmallButton>
        <SmallButton
          title="Abre tu programa de correo con el borrador; tú decides si lo envías"
          onClick={() => {
            window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          }}
        >
          Abrir en mi correo
        </SmallButton>
      </div>
      <p className="text-xs text-ink-secondary">
        El asistente no envía nada: el mensaje sale solo cuando tú lo envías desde tu correo.
      </p>
    </div>
  );
}

export function ResultView({ artifact }: Readonly<{ artifact: SalesArtifact }>) {
  const records = useSales((s) => s.state?.records ?? []);
  const { result } = artifact;
  return (
    <div className="space-y-4" data-sales-result={artifact.flow}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
        <Badge tone="info">{SALES_FLOW_LABEL[artifact.flow]}</Badge>
        {artifact.demo && <DemoTag />}
        <span>
          {artifact.ownerName} · {fmtDay(new Date(artifact.updatedAt).toISOString())}
        </span>
      </div>
      {result.summary && <p className="text-sm text-ink">{result.summary}</p>}
      {result.sections.map((section) => (
        <section key={section.heading}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            {section.heading}
          </h4>
          <ul className="space-y-1.5">
            {section.items.map((item, i) => (
              <li key={i} className="rounded-lg bg-white/[0.04] px-3 py-2">
                <div className="flex items-start gap-2">
                  <Badge tone={KIND_TONE[item.kind]}>{SALES_ITEM_LABEL[item.kind]}</Badge>
                  <div className="min-w-0 flex-1">
                    {item.quote && (
                      <blockquote
                        className={`border-l-2 pl-2 text-sm ${
                          item.kind === "cita"
                            ? "border-primary text-ink"
                            : "border-line italic text-ink-secondary"
                        }`}
                      >
                        {item.kind === "cita" ? `«${item.quote}»` : item.quote}
                      </blockquote>
                    )}
                    {item.text && (
                      <p
                        className={`break-words text-sm ${item.quote ? "mt-1 text-ink-secondary" : "text-ink"}`}
                      >
                        {item.text}
                      </p>
                    )}
                    {(item.owner || item.due) && (
                      <p className="mt-0.5 text-xs text-ink-secondary">
                        {item.owner && `Responsable: ${item.owner}`}
                        {item.owner && item.due && " · "}
                        {item.due && `Fecha: ${item.due}`}
                      </p>
                    )}
                    <Sources ids={item.sources} records={records} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {result.draft.body && <Draft key={artifact.updatedAt} artifact={artifact} />}
      {result.crmUpdates.length > 0 && <CrmProposal key={artifact.updatedAt} artifact={artifact} />}
      {result.slides.length > 0 && (
        <SlidesEditor
          key={artifact.updatedAt}
          name={result.title || "presentacion"}
          initial={result.slides}
        />
      )}
      {result.sections.length === 0 &&
        !result.draft.body &&
        result.slides.length === 0 &&
        !result.summary && (
          <p className="text-sm text-ink-secondary">El asistente no devolvió contenido.</p>
        )}
    </div>
  );
}

/** The result open on top of the tab (`?result=<id>`). */
export function ResultModal() {
  const nav = useSalesNav();
  const artifact = useSales((s) => s.state?.artifacts.find((a) => a.id === nav.resultId));
  if (!artifact) return null;
  const close = () => nav.go({ result: "" });
  return (
    <Modal
      title={artifact.result.title || SALES_FLOW_LABEL[artifact.flow]}
      onClose={close}
      width="lg"
      footer={<SecondaryButton onClick={close}>Cerrar</SecondaryButton>}
    >
      <ResultView artifact={artifact} />
    </Modal>
  );
}

/**
 * A flow's button: opens its last result when there is one (with "Regenerar"),
 * otherwise asks the assistant. `prompt` asks the person for what the flow
 * needs first (a question, a recipient, a brief).
 */
export function FlowButton({
  flow,
  label,
  refs = {},
  prompt,
  extra = {},
  primary,
}: Readonly<{
  flow: SalesFlow;
  label: string;
  refs?: { accountId?: string; opportunityId?: string; meetingId?: string };
  prompt?: { label: string; placeholder: string };
  extra?: Partial<SalesAiInput>;
  primary?: boolean;
}>) {
  const nav = useSalesNav();
  const ask = useSales((s) => s.ask);
  const running = useSales((s) => s.running);
  const artifacts = useSales((s) => s.state?.artifacts ?? []);
  const showToast = useChat((s) => s.showToast);
  const [asking, setAsking] = useState(false);
  const [input, setInput] = useState("");
  const key = `${flow}:${refs.accountId ?? ""}:${refs.opportunityId ?? ""}:${refs.meetingId ?? ""}`;
  const existing = prompt ? undefined : artifactOf(artifacts, flow, refs);
  const busy = running === key;

  async function run(text = "") {
    try {
      const artifact = await ask({ flow, ...refs, ...extra, input: text }, key);
      setAsking(false);
      setInput("");
      nav.go({ result: artifact.id });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "El asistente no pudo responder.", "error");
    }
  }

  return (
    <>
      <span className="inline-flex">
        <SmallButton
          primary={primary}
          disabled={busy || (running !== null && !busy)}
          onClick={() =>
            existing ? nav.go({ result: existing.id }) : prompt ? setAsking(true) : void run()
          }
        >
          {busy ? "Generando…" : existing ? `Ver: ${label}` : label}
        </SmallButton>
        {existing && !busy && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={running !== null}
            className="ml-1 rounded-lg px-1.5 text-xs text-ink-secondary hover:text-ink disabled:opacity-50"
            title="Generar de nuevo con los datos actuales"
            aria-label={`Regenerar: ${label}`}
          >
            ↻
          </button>
        )}
      </span>
      {asking && prompt && (
        <Modal
          title={label}
          onClose={() => setAsking(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setAsking(false)}>Cancelar</SecondaryButton>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || input.trim().length === 0}
                onClick={() => void run(input.trim())}
              >
                {busy ? "Generando…" : "Generar"}
              </button>
            </>
          }
        >
          <label className="block text-sm font-medium text-ink">
            {prompt.label}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={6}
              placeholder={prompt.placeholder}
              className="input mt-1 w-full text-sm"
            />
          </label>
        </Modal>
      )}
    </>
  );
}
