import {
  DEMO_ACCOUNT_ID,
  DEMO_MEETING_ID,
  DEMO_OPP_ID,
  DEMO_PAST_MEETING_ID,
  duplicateOf,
  leadsSales,
  salesCsv,
  type SalesAccount,
  type SalesCompetitor,
  type SalesDoc,
  type SalesLead,
} from "@mindfultech/shared";
import { useMemo, useState } from "react";
import { downloadBytes } from "../../lib/pptx";
import { useChat } from "../../store";
import { artifactOf, useSales } from "../../store/sales";
import { RecordForm, type RecordFormTarget } from "./RecordForm";
import { FlowButton, ResultView } from "./Result";
import { Badge, Card, DemoTag, Empty, fmtDay, SmallButton, useSalesNav } from "./ui";

// Ventas (Phase 73): prospecting, internal answers and the guided demo.

// --- Prospección (descubrimiento y enriquecimiento) ---------------------------------

export function ProspectingTab() {
  const records = useSales((s) => s.state?.records ?? []);
  const artifacts = useSales((s) => s.state?.artifacts ?? []);
  const ask = useSales((s) => s.ask);
  const running = useSales((s) => s.running);
  const importLeads = useSales((s) => s.importLeads);
  const showToast = useChat((s) => s.showToast);
  const me = useChat((s) => s.me);
  const [icp, setIcp] = useState("");
  const [sources, setSources] = useState("");
  const [segment, setSegment] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const last = artifactOf(
    artifacts.filter((a) => a.ownerId === me?.userId),
    "discovery",
  );
  const leads = useMemo(() => last?.result.leads ?? [], [last]);
  const accounts = records.filter((r): r is SalesAccount => r.kind === "account");
  const rows = leads.map((lead, index) => ({ lead, index, dup: duplicateOf(lead, accounts) }));
  const segments = [...new Set(leads.map((l) => l.industry).filter(Boolean))].sort();
  const shown = rows.filter((r) => !segment || r.lead.industry === segment);

  async function search() {
    try {
      await ask({
        flow: "discovery",
        input: `Perfil de cliente ideal:\n${icp}\n\nFuentes:\n${sources}`,
      });
      setPicked(new Set());
    } catch (err) {
      showToast(err instanceof Error ? err.message : "El asistente no pudo responder.", "error");
    }
  }
  async function add() {
    setBusy(true);
    try {
      const done = await importLeads(rows.filter((r) => picked.has(r.index)).map((r) => r.lead));
      showToast(
        `${done.added} ${done.added === 1 ? "registro agregado" : "registros agregados"}${done.skipped ? ` · ${done.skipped} ya existían` : ""}`,
        "success",
      );
      setPicked(new Set());
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo importar.", "error");
    }
    setBusy(false);
  }
  const exportCsv = (list: SalesLead[]) =>
    downloadBytes(
      "prospectos.csv",
      `\uFEFF${salesCsv(
        [
          "Empresa",
          "Sitio",
          "Industria",
          "País",
          "Tamaño",
          "Contacto",
          "Cargo",
          "Correo",
          "Por qué encaja",
          "Fuente",
        ],
        list.map((l) => [
          l.company,
          l.domain,
          l.industry,
          l.country,
          l.size,
          l.contactName || "(por identificar)",
          l.contactTitle,
          l.email,
          l.fit,
          l.source,
        ]),
      )}`,
      "text/csv;charset=utf-8",
    );

  return (
    <div className="space-y-3" data-sales-tab="prospeccion">
      <Card title="Descubrimiento y enriquecimiento">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm font-medium text-ink">
            Perfil de cliente ideal
            <textarea
              value={icp}
              onChange={(e) => setIcp(e.target.value)}
              rows={5}
              className="input mt-1 w-full text-sm"
              placeholder="Distribuidoras en Ecuador con 50 a 500 empleados que toman pedidos por WhatsApp. Cargo objetivo: gerente de operaciones."
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Fuentes (pega listados, directorios, notas o un CSV)
            <textarea
              value={sources}
              onChange={(e) => setSources(e.target.value)}
              rows={5}
              className="input mt-1 w-full text-sm"
              placeholder="Directorio de la Cámara de Comercio (2026-11):&#10;Distribuidora X — Guayaquil — distribuidorax.com — 120 empleados…"
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={running !== null || !icp.trim() || !sources.trim()}
            onClick={() => void search()}
          >
            {running === "discovery" ? "Buscando…" : "Encontrar empresas y contactos"}
          </button>
          <p className="text-xs text-ink-secondary">
            Trabaja con lo que pegas: no hay una integración de datos externa conectada.
          </p>
        </div>
      </Card>
      {last && (
        <Card
          title={`Resultados (${leads.length})`}
          action={
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
                aria-label="Segmento"
                className="input py-0.5 text-xs"
              >
                <option value="">Todos los segmentos</option>
                {segments.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <SmallButton
                onClick={() => exportCsv(shown.map((r) => r.lead))}
                disabled={shown.length === 0}
              >
                Exportar CSV
              </SmallButton>
              <SmallButton primary disabled={busy || picked.size === 0} onClick={() => void add()}>
                Agregar {picked.size || ""} a Clientes
              </SmallButton>
            </div>
          }
        >
          {leads.length === 0 ? (
            <Empty>
              {last.result.summary || "No se encontraron empresas que encajen en esas fuentes."}
            </Empty>
          ) : (
            <ul className="divide-y divide-line" data-sales-leads>
              {shown.map(({ lead, index, dup }) => (
                <li key={index} className="flex items-start gap-2 py-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Seleccionar ${lead.company}`}
                    checked={picked.has(index)}
                    disabled={!!dup}
                    onChange={(e) =>
                      setPicked((p) => {
                        const next = new Set(p);
                        if (e.target.checked) next.add(index);
                        else next.delete(index);
                        return next;
                      })
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                      {lead.company}
                      {dup && <Badge tone="warn">Duplicado: ya es un cliente</Badge>}
                      {!lead.contactName && (
                        <Badge tone="neutral">Falta identificar al contacto</Badge>
                      )}
                    </p>
                    <p className="text-xs text-ink-secondary">
                      {[lead.industry, lead.country, lead.size, lead.domain]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="text-xs text-ink">
                      {lead.contactName
                        ? `${lead.contactName} · ${lead.contactTitle}`
                        : `Cargo objetivo: ${lead.contactTitle || "por definir"}`}
                      {lead.email ? ` · ${lead.email}` : ""}
                    </p>
                    {lead.fit && <p className="text-xs text-ink-secondary">{lead.fit}</p>}
                    <p className="text-[11px] text-ink-secondary">
                      Fuente: {lead.source || "la fuente pegada"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {last.result.sections.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <ResultView artifact={{ ...last, result: { ...last.result, leads: [] } }} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// --- Respuestas internas (documentos y competidores) ----------------------------------

export function KnowledgeTab() {
  const nav = useSalesNav();
  const me = useChat((s) => s.me);
  const records = useSales((s) => s.state?.records ?? []);
  const artifacts = useSales((s) => s.state?.artifacts ?? []);
  const ask = useSales((s) => s.ask);
  const running = useSales((s) => s.running);
  const showToast = useChat((s) => s.showToast);
  const [question, setQuestion] = useState("");
  const [form, setForm] = useState<RecordFormTarget | null>(null);
  const docs = records.filter((r): r is SalesDoc => r.kind === "doc");
  const competitors = records.filter((r): r is SalesCompetitor => r.kind === "competitor");
  const answer = artifactOf(
    artifacts.filter((a) => a.ownerId === me?.userId),
    "answer",
  );
  const mine = (r: { ownerId: string; demo?: true }) =>
    r.demo || r.ownerId === me?.userId || leadsSales(me?.role);

  async function run() {
    try {
      await ask({ flow: "answer", input: question.trim() });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "El asistente no pudo responder.", "error");
    }
  }
  return (
    <div className="space-y-3" data-sales-tab="conocimiento">
      <Card title="¿Qué es esto?">
        <p className="text-sm text-ink">
          Cuando un cliente te pregunta algo (precios, plazos, qué tecnologías usamos, cómo
          trabajamos), escríbelo aquí y el asistente te da la respuesta lista para enviar, usando{" "}
          <strong>solo los documentos de MindfulTech</strong> que el equipo haya cargado abajo.
        </p>
        <ol className="mt-2 grid gap-2 text-xs text-ink-secondary sm:grid-cols-3">
          <li className="rounded-lg border border-line p-2">
            <strong className="text-ink">1. Carga documentos.</strong> Propuestas tipo, tarifas,
            metodología, casos de éxito, respuestas ya aprobadas. Pega el texto y di quién es el
            experto.
          </li>
          <li className="rounded-lg border border-line p-2">
            <strong className="text-ink">2. Haz la pregunta.</strong> Tal como te la hizo el
            cliente.
          </li>
          <li className="rounded-lg border border-line p-2">
            <strong className="text-ink">3. Revisa y envía.</strong> Sale un borrador editable, con
            el documento del que salió cada dato y a quién consultar. Lo que no esté en los
            documentos, lo dice.
          </li>
        </ol>
      </Card>
      <Card title="Pregunta de un cliente">
        {docs.length === 0 ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-ink-secondary">
              Todavía no hay documentos, así que el asistente no tiene de dónde responder.
            </p>
            <button type="button" className="btn-primary" onClick={() => setForm({ kind: "doc" })}>
              Cargar el primer documento
            </button>
          </div>
        ) : (
          <>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              className="input w-full text-sm"
              placeholder="Escribe la pregunta del cliente…"
              aria-label="Pregunta"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                "¿Cuánto cuesta y cuánto tarda un proyecto como este?",
                "¿Qué incluye el soporte después de la entrega?",
                "¿Con qué sistemas se pueden integrar?",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setQuestion(example)}
                  className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-secondary hover:border-primary/60 hover:text-ink"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={running !== null || !question.trim()}
                onClick={() => void run()}
              >
                {running === "answer" ? "Buscando en los documentos…" : "Preparar la respuesta"}
              </button>
              <p className="text-xs text-ink-secondary">
                Usa los {docs.length} {docs.length === 1 ? "documento" : "documentos"} de abajo y
                cita cada uno.
              </p>
            </div>
          </>
        )}
        {answer && (
          <div className="mt-3 border-t border-line pt-3">
            <ResultView artifact={answer} />
          </div>
        )}
      </Card>
      <Card
        title={`Documentos de MindfulTech (${docs.length})`}
        action={<SmallButton onClick={() => setForm({ kind: "doc" })}>+ Documento</SmallButton>}
      >
        {docs.length === 0 ? (
          <Empty>
            Agrega fichas técnicas, políticas comerciales o respuestas aprobadas: el asistente
            responde con ellas.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {docs.map((d) => (
              <li
                key={d.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-1.5 ${nav.focus === d.id ? "rounded-lg bg-primary/5 px-2" : ""}`}
              >
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-ink">{d.title}</span> {d.demo && <DemoTag />}
                  <span className="block text-xs text-ink-secondary">
                    {[
                      d.expertName && `Experto: ${d.expertName}`,
                      d.tags,
                      d.sourceDate && fmtDay(d.sourceDate),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {mine(d) && (
                  <SmallButton onClick={() => setForm({ kind: "doc", record: d })}>
                    Editar
                  </SmallButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card
        title={`Competidores (${competitors.length})`}
        action={
          <div className="flex gap-1.5">
            <FlowButton
              flow="competitive"
              label="Comparar"
              prompt={{
                label: "Criterios de compra del cliente",
                placeholder: "Integración con ERP, soporte local, costo total a 2 años…",
              }}
            />
            <SmallButton onClick={() => setForm({ kind: "competitor" })}>+ Competidor</SmallButton>
          </div>
        }
      >
        {competitors.length === 0 ? (
          <Empty>
            Agrega lo que se sabe de cada proveedor, con su fuente: la ficha comparativa sale de
            aquí.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {competitors.map((c) => (
              <li
                key={c.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-1.5 ${nav.focus === c.id ? "rounded-lg bg-primary/5 px-2" : ""}`}
              >
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-ink">{c.name}</span> {c.demo && <DemoTag />}
                  <span className="block text-xs text-ink-secondary">
                    {c.pricing || c.strengths.slice(0, 90)}
                  </span>
                </div>
                {mine(c) && (
                  <SmallButton onClick={() => setForm({ kind: "competitor", record: c })}>
                    Editar
                  </SmallButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {form && <RecordForm target={form} onClose={() => setForm(null)} />}
    </div>
  );
}

// --- Demo guiada ---------------------------------------------------------------------

export function DemoTab() {
  const nav = useSalesNav();
  const records = useSales((s) => s.state?.records ?? []);
  const artifacts = useSales((s) => s.state?.artifacts ?? []);
  const resetDemo = useSales((s) => s.resetDemo);
  const clearDemo = useSales((s) => s.clearDemo);
  async function clear() {
    try {
      await clearDemo();
      showToast("Demo quitada: quedan solo tus datos reales", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo quitar la demo.", "error");
    }
  }
  const loading = useSales((s) => s.loading);
  const showToast = useChat((s) => s.showToast);
  const loaded = records.some((r) => r.id === DEMO_OPP_ID);
  const result = (flow: "prep" | "deck" | "followup") =>
    artifacts.find((a) => a.id === `demo_art_${flow}`)?.id ?? "";

  async function reset() {
    try {
      await resetDemo();
      showToast("Demo cargada con sus datos originales", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo reiniciar la demo.", "error");
    }
  }
  const steps: Array<{ who: string; title: string; text: string; action: string; go: () => void }> =
    [
      {
        who: "Líder",
        title: "Detecta un riesgo en el pronóstico",
        text: "En lo comprometido de los próximos 30 días hay una oportunidad de USD 84.000 sin próximo paso, sin decisor identificado y sin reuniones recientes.",
        action: "Abrir el pronóstico",
        go: () => nav.go({ tab: "pronostico" }),
      },
      {
        who: "Vendedor",
        title: "Revisa el cliente",
        text: "Farmacias Andina: la oportunidad, sus riesgos, los contactos y qué cambió (se movió a comprometida y subió de monto).",
        action: "Abrir el cliente",
        go: () => nav.go({ tab: "cuentas", account: DEMO_ACCOUNT_ID, focus: DEMO_OPP_ID }),
      },
      {
        who: "Vendedor",
        title: "Prepara la reunión con Finanzas",
        text: "Asistentes, historial con citas textuales de la reunión anterior, bloqueos, preguntas sugeridas y resultado deseado.",
        action: "Ver la preparación",
        go: () =>
          nav.go({
            tab: "cuentas",
            account: DEMO_ACCOUNT_ID,
            focus: DEMO_MEETING_ID,
            result: result("prep"),
          }),
      },
      {
        who: "Vendedor",
        title: "Genera la presentación del caso de negocio",
        text: "Diez diapositivas construidas desde el modelo de ROI de la oportunidad: las mismas cifras, exportables a PowerPoint.",
        action: "Ver la presentación",
        go: () =>
          nav.go({
            tab: "cuentas",
            account: DEMO_ACCOUNT_ID,
            focus: DEMO_OPP_ID,
            result: result("deck"),
          }),
      },
      {
        who: "Vendedor",
        title: "Revisa el seguimiento y la actualización del CRM",
        text: "Acuerdos, objeciones y tareas de la reunión, el correo editable y los cambios propuestos a la oportunidad: se aplican solo al confirmar.",
        action: "Ver el seguimiento",
        go: () =>
          nav.go({
            tab: "cuentas",
            account: DEMO_ACCOUNT_ID,
            focus: DEMO_PAST_MEETING_ID,
            result: result("followup"),
          }),
      },
      {
        who: "Líder",
        title: "Vuelve al pronóstico",
        text: "Con los cambios confirmados, la oportunidad sale de lo comprometido y queda con próximo paso y fecha. El total se recalcula.",
        action: "Ver el pronóstico actualizado",
        go: () => nav.go({ tab: "pronostico" }),
      },
    ];
  return (
    <div className="space-y-3" data-sales-tab="demo">
      <Card
        title="Demo guiada"
        action={
          <div className="flex gap-1.5">
            {loaded && (
              <SmallButton disabled={loading} onClick={() => void clear()}>
                Quitar la demo
              </SmallButton>
            )}
            <SmallButton primary={!loaded} disabled={loading} onClick={() => void reset()}>
              {loading ? "Cargando…" : loaded ? "Reiniciar demo" : "Cargar la demo"}
            </SmallButton>
          </div>
        }
      >
        <p className="text-sm text-ink-secondary">
          Un recorrido con un solo cliente y una sola oportunidad, de principio a fin. Todos los
          datos son <strong className="text-warning">ficticios</strong> y llevan la marca{" "}
          <DemoTag />: no se mezclan con tus clientes y funcionan sin credenciales externas. El
          interruptor «Datos demo» de arriba los muestra u oculta solo para ti; «Reiniciar demo» los
          devuelve a su estado original y «Quitar la demo» los borra (tus datos reales no se tocan).
        </p>
      </Card>
      {loaded ? (
        <ol className="space-y-2" data-sales-demo-steps>
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-sm font-bold text-primary">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                  {s.title} <Badge tone={s.who === "Líder" ? "info" : "neutral"}>{s.who}</Badge>
                </p>
                <p className="text-xs text-ink-secondary">{s.text}</p>
              </div>
              <SmallButton primary onClick={s.go}>
                {s.action}
              </SmallButton>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>Carga la demo para empezar el recorrido.</Empty>
      )}
    </div>
  );
}
