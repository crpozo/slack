import {
  ACCOUNT_STATUS_LABEL,
  CONTACT_ROLE_LABEL,
  FORECAST_LABEL,
  leadsSales,
  SALES_SERVICE_LABEL,
  SALES_STAGE_LABEL,
  SalesRecordSchema,
  type SalesInput,
  type SalesRecord,
} from "@mindfultech/shared";
import { useState } from "react";
import { useChat } from "../../store";
import { newSalesId, useSales } from "../../store/sales";
import { Modal, SecondaryButton } from "../Modal";

// Ventas (Phase 73): one form for every kind of record, from a table of its fields.

type Kind = SalesRecord["kind"];
interface Field {
  name: string;
  label: string;
  type?: "text" | "area" | "long" | "number" | "date" | "datetime" | "check" | "select";
  options?: Record<string, string>;
  hint?: string;
}

const SOURCE: Field[] = [
  {
    name: "source",
    label: "Fuente del dato",
    hint: "De dónde salió (un enlace, un directorio, una llamada)",
  },
  { name: "sourceDate", label: "Fecha de la fuente", type: "date" },
];

const FIELDS: Record<Kind, Field[]> = {
  account: [
    { name: "name", label: "Empresa" },
    { name: "domain", label: "Sitio web" },
    { name: "industry", label: "Industria" },
    { name: "size", label: "Tamaño" },
    { name: "country", label: "País" },
    { name: "segment", label: "Segmento" },
    { name: "status", label: "Estado", type: "select", options: ACCOUNT_STATUS_LABEL },
    { name: "strategic", label: "Cliente estratégico", type: "check" },
    { name: "notes", label: "Notas", type: "area" },
    ...SOURCE,
  ],
  contact: [
    { name: "name", label: "Nombre", hint: "Déjalo vacío si aún no se identifica a la persona" },
    { name: "title", label: "Cargo" },
    {
      name: "role",
      label: "Rol en la decisión",
      type: "select",
      options: { "": "Sin definir", ...CONTACT_ROLE_LABEL },
    },
    { name: "email", label: "Correo" },
    { name: "phone", label: "Teléfono" },
    { name: "notes", label: "Notas", type: "area" },
    ...SOURCE,
  ],
  opportunity: [
    { name: "name", label: "Oportunidad" },
    {
      name: "type",
      label: "Tipo",
      type: "select",
      options: { nueva: "Proyecto nuevo", renovacion: "Renovación", expansion: "Ampliación" },
    },
    {
      name: "service",
      label: "Servicio",
      type: "select",
      options: { "": "Sin definir", ...SALES_SERVICE_LABEL },
    },
    { name: "amount", label: "Monto", type: "number" },
    { name: "currency", label: "Moneda (USD, EUR…)" },
    { name: "stage", label: "Etapa", type: "select", options: SALES_STAGE_LABEL },
    {
      name: "forecastCategory",
      label: "Categoría de pronóstico",
      type: "select",
      options: {
        commit: FORECAST_LABEL.commit,
        best_case: FORECAST_LABEL.best_case,
        pipeline: FORECAST_LABEL.pipeline,
        omitted: FORECAST_LABEL.omitted,
      },
    },
    { name: "closeDate", label: "Fecha de cierre", type: "date" },
    { name: "nextStep", label: "Próximo paso" },
    { name: "nextStepDate", label: "Fecha del próximo paso", type: "date" },
    { name: "criteria", label: "Criterios de decisión", type: "area" },
    { name: "process", label: "Proceso de decisión", type: "area" },
    { name: "risks", label: "Riesgos", type: "area" },
  ],
  meeting: [
    { name: "title", label: "Reunión" },
    { name: "date", label: "Fecha y hora", type: "datetime" },
    { name: "attendees", label: "Asistentes" },
    { name: "goal", label: "Objetivo", type: "area" },
    {
      name: "notes",
      label: "Notas o transcripción",
      type: "long",
      hint: "Pega las notas o la transcripción. Con «[00:12:30] Nombre: texto» las citas llevan hablante y minuto.",
    },
  ],
  call: [
    { name: "title", label: "Llamada" },
    { name: "date", label: "Fecha y hora", type: "datetime" },
    {
      name: "repName",
      label: "Nombre del vendedor en la transcripción",
      hint: "Como aparece antes de los dos puntos: «Lucía»",
    },
    {
      name: "transcript",
      label: "Transcripción",
      type: "long",
      hint: "Una línea por intervención: «[00:01:10] Lucía: texto»",
    },
    {
      name: "shareable",
      label: "Mis colegas pueden ver esta llamada",
      type: "check",
    },
  ],
  doc: [
    { name: "title", label: "Documento" },
    { name: "body", label: "Contenido", type: "long" },
    { name: "expertName", label: "Experto o responsable del tema" },
    { name: "tags", label: "Etiquetas" },
    { name: "url", label: "Enlace" },
    { name: "sourceDate", label: "Fecha del documento", type: "date" },
  ],
  competitor: [
    { name: "name", label: "Proveedor" },
    { name: "strengths", label: "Fortalezas", type: "area" },
    { name: "weaknesses", label: "Debilidades", type: "area" },
    { name: "pricing", label: "Precios", type: "area" },
    { name: "notes", label: "Notas", type: "area" },
    { name: "url", label: "Enlace de la fuente" },
    { name: "sourceDate", label: "Fecha de la fuente", type: "date" },
  ],
};

const KIND_LABEL: Record<Kind, string> = {
  account: "cliente",
  contact: "contacto",
  opportunity: "oportunidad",
  meeting: "reunión",
  call: "llamada",
  doc: "documento",
  competitor: "competidor",
};
const PREFIX: Record<Kind, string> = {
  account: "acct",
  contact: "ct",
  opportunity: "opp",
  meeting: "meet",
  call: "call",
  doc: "doc",
  competitor: "comp",
};

/** `2026-11-20T15:00:00.000Z` ↔ what `<input type="datetime-local">` holds. */
const toLocal = (iso: string) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export interface RecordFormTarget {
  kind: Kind;
  /** The record being edited; none: a new one. */
  record?: SalesRecord;
  /** What a new record hangs from. */
  defaults?: Record<string, unknown>;
}

export function RecordForm({
  target,
  onClose,
}: Readonly<{ target: RecordFormTarget; onClose: () => void }>) {
  const { kind, record } = target;
  const save = useSales((s) => s.save);
  const remove = useSales((s) => s.remove);
  const people = useSales((s) => s.state?.people ?? []);
  const projects = useSales((s) => s.state?.projects ?? []);
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...(kind === "meeting" || kind === "call" ? { date: new Date().toISOString() } : {}),
    ...target.defaults,
    ...record,
  }));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }));

  const candidate = { ...values, kind, id: record?.id ?? "new_record" };
  const parsed = SalesRecordSchema.safeParse(candidate);

  async function submit() {
    if (!parsed.success || busy) return;
    setBusy(true);
    try {
      await save({ ...(parsed.data as SalesInput), id: record?.id ?? newSalesId(PREFIX[kind]) });
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar.", "error");
    }
    setBusy(false);
  }
  async function destroy() {
    if (!record) return;
    setBusy(true);
    try {
      await remove(record.id);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo eliminar.", "error");
    }
    setBusy(false);
  }

  return (
    <Modal
      title={`${record ? "Editar" : "Nueva"} ${KIND_LABEL[kind]}`
        .replace("Nueva cliente", "Nuevo cliente")
        .replace("Nueva contacto", "Nuevo contacto")
        .replace("Nueva documento", "Nuevo documento")
        .replace("Nueva competidor", "Nuevo competidor")}
      onClose={onClose}
      width="lg"
      footer={
        <>
          {record &&
            (confirmDelete ? (
              <button
                type="button"
                className="mr-auto text-sm font-semibold text-error"
                disabled={busy}
                onClick={() => void destroy()}
              >
                Sí, eliminar{kind === "account" ? " el cliente y todo lo suyo" : ""}
              </button>
            ) : (
              <button
                type="button"
                className="mr-auto text-sm text-ink-secondary hover:text-error"
                onClick={() => setConfirmDelete(true)}
              >
                Eliminar
              </button>
            ))}
          <SecondaryButton onClick={onClose}>Cancelar</SecondaryButton>
          <button
            type="button"
            className="btn-primary"
            disabled={!parsed.success || busy}
            onClick={() => void submit()}
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-sales-form={kind}>
        {FIELDS[kind].map((f) => {
          const value = values[f.name];
          const wide = f.type === "area" || f.type === "long" || f.type === "check";
          return (
            <label
              key={f.name}
              className={`block text-sm font-medium text-ink ${wide ? "sm:col-span-2" : ""}`}
            >
              {f.type === "check" ? (
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) => set(f.name, e.target.checked)}
                  />
                  {f.label}
                </span>
              ) : (
                <>
                  {f.label}
                  {f.type === "select" ? (
                    <select
                      value={String(value ?? Object.keys(f.options ?? {})[0] ?? "")}
                      onChange={(e) => set(f.name, e.target.value)}
                      className="input mt-1 w-full"
                    >
                      {Object.entries(f.options ?? {}).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "area" || f.type === "long" ? (
                    <textarea
                      value={String(value ?? "")}
                      onChange={(e) => set(f.name, e.target.value)}
                      rows={f.type === "long" ? 10 : 3}
                      className="input mt-1 w-full text-sm"
                    />
                  ) : f.type === "number" ? (
                    <input
                      inputMode="decimal"
                      value={value === undefined ? "" : String(value)}
                      onChange={(e) =>
                        set(
                          f.name,
                          e.target.value === "" ? 0 : Number(e.target.value.replace(",", ".")) || 0,
                        )
                      }
                      className="input mt-1 w-full"
                    />
                  ) : f.type === "datetime" ? (
                    <input
                      type="datetime-local"
                      value={toLocal(String(value ?? ""))}
                      onChange={(e) =>
                        set(f.name, e.target.value ? new Date(e.target.value).toISOString() : "")
                      }
                      className="input mt-1 w-full"
                    />
                  ) : (
                    <input
                      type={f.type === "date" ? "date" : "text"}
                      value={String(value ?? "")}
                      onChange={(e) => set(f.name, e.target.value)}
                      className="input mt-1 w-full"
                    />
                  )}
                </>
              )}
              {f.hint && (
                <span className="mt-0.5 block text-xs font-normal text-ink-secondary">
                  {f.hint}
                </span>
              )}
            </label>
          );
        })}
        {kind === "account" && (
          <label className="block text-sm font-medium text-ink">
            Proyecto en la plataforma
            <select
              value={String(values.channelId ?? "")}
              onChange={(e) => set("channelId", e.target.value)}
              className="input mt-1 w-full"
            >
              <option value="">Sin proyecto</option>
              {typeof values.channelId === "string" &&
                values.channelId &&
                !projects.some((p) => p.channelId === values.channelId) && (
                  <option value={values.channelId}>Proyecto vinculado</option>
                )}
              {projects.map((p) => (
                <option key={p.channelId} value={p.channelId}>
                  #{p.name}
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-xs font-normal text-ink-secondary">
              El canal donde se trabaja para este cliente: trae sus horas registradas.
            </span>
          </label>
        )}
        {leadsSales(me?.role) && (
          <label className="block text-sm font-medium text-ink">
            Responsable
            <select
              value={String(values.ownerId ?? me?.userId ?? "")}
              onChange={(e) => set("ownerId", e.target.value)}
              className="input mt-1 w-full"
            >
              {record && !people.some((p) => p.userId === record.ownerId) && (
                <option value={record.ownerId}>{record.ownerName}</option>
              )}
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!parsed.success && (
        <p className="mt-2 text-xs text-warning">
          Falta:{" "}
          {parsed.error.issues
            .map((i) => FIELDS[kind].find((f) => f.name === i.path[0])?.label ?? String(i.path[0]))
            .join(", ")}
        </p>
      )}
    </Modal>
  );
}
