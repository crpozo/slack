import {
  callMetrics,
  coachingTrend,
  DEMO_ACCOUNT_ID,
  DEMO_MEETING_ID,
  DEMO_OPP_ID,
  DEMO_PAST_MEETING_ID,
  DEMO_REP_ID,
  duplicateOf,
  leadsSales,
  salesCsv,
  type SalesAccount,
  type SalesCall,
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

// Ventas (Phase 73): prospecting, internal answers, coaching and the guided demo.

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
      <Card title="Pregunta comercial o técnica">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          className="input w-full text-sm"
          placeholder="¿Con qué ERP nos integramos y cuánto tarda una integración?"
          aria-label="Pregunta"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={running !== null || !question.trim()}
            onClick={() => void run()}
          >
            {running === "answer" ? "Buscando en los documentos…" : "Responder con los documentos"}
          </button>
          <p className="text-xs text-ink-secondary">
            Solo usa los documentos de abajo y cita cada uno.
          </p>
        </div>
        {answer && (
          <div className="mt-3 border-t border-line pt-3">
            <ResultView artifact={answer} />
          </div>
        )}
      </Card>
      <Card
        title={`Documentos autorizados (${docs.length})`}
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

// --- Coaching ------------------------------------------------------------------------

export function CoachingTab() {
  const nav = useSalesNav();
  const me = useChat((s) => s.me);
  const records = useSales((s) => s.state?.records ?? []);
  const artifacts = useSales((s) => s.state?.artifacts ?? []);
  const ask = useSales((s) => s.ask);
  const running = useSales((s) => s.running);
  const showToast = useChat((s) => s.showToast);
  const calls = useMemo(() => records.filter((r): r is SalesCall => r.kind === "call"), [records]);
  // Whose calls can be coached here: mine, the demo's rep, and anyone's for a lead.
  const reps = useMemo(() => {
    const all = new Map<string, string>();
    if (me) all.set(me.userId, "Mis llamadas");
    for (const c of calls) {
      if (c.ownerId === me?.userId) continue;
      if (c.demo || leadsSales(me?.role)) all.set(c.ownerId, c.ownerName);
    }
    return [...all.entries()];
  }, [calls, me]);
  const [picked, setPicked] = useState("");
  const repId = reps.some(([id]) => id === picked)
    ? picked
    : reps.some(([id]) => id === nav.focus)
      ? nav.focus
      : (calls.find((c) => c.id === nav.focus)?.ownerId ??
        (calls.some((c) => c.ownerId === me?.userId)
          ? (me?.userId ?? "")
          : (reps.find(([id]) => id === DEMO_REP_ID)?.[0] ?? me?.userId ?? "")));
  const theirs = calls
    .filter((c) => c.ownerId === repId)
    .sort((a, b) => b.date.localeCompare(a.date));
  const [since, setSince] = useState(() =>
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const trend = useMemo(() => coachingTrend(theirs, since), [theirs, since]);
  const [form, setForm] = useState<RecordFormTarget | null>(null);
  const result = (flow: "coaching" | "trends") =>
    artifacts
      .filter((a) => a.flow === flow && a.repId === repId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const [shown, setShown] = useState<"coaching" | "trends">("coaching");
  const artifact = result(shown);

  async function run(flow: "coaching" | "trends") {
    setShown(flow);
    try {
      await ask({ flow, repId, since: flow === "trends" ? since : "" }, flow);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "El asistente no pudo responder.", "error");
    }
  }
  const verdictTone = { mejora: "good", retroceso: "bad", estable: "neutral" } as const;

  return (
    <div className="space-y-3" data-sales-tab="coaching">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={repId}
          onChange={(e) => setPicked(e.target.value)}
          aria-label="Vendedor"
          className="input"
        >
          {reps.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <SmallButton onClick={() => setForm({ kind: "call" })}>
          + Llamada (pegar transcripción)
        </SmallButton>
      </div>
      <Card title={`Llamadas (${theirs.length})`}>
        {theirs.length === 0 ? (
          <Empty>Sin llamadas. Pega la transcripción de una llamada para recibir coaching.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-sales-calls>
              <thead className="text-xs text-ink-secondary">
                <tr>
                  {["Llamada", "Fecha", "Habla (%)", "Preguntas", "Intervención más larga"].map(
                    (h, i) => (
                      <th
                        key={h}
                        className={`px-2 py-1.5 font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {theirs.map((c) => {
                  const m = callMetrics(c);
                  const editable = c.demo || c.ownerId === me?.userId || leadsSales(me?.role);
                  return (
                    <tr key={c.id} className={nav.focus === c.id ? "bg-primary/5" : ""}>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() => setForm({ kind: "call", record: c })}
                          className="text-left font-medium text-ink hover:underline disabled:no-underline"
                        >
                          {c.title}
                        </button>{" "}
                        {c.demo && <DemoTag />}
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs text-ink-secondary">
                        {fmtDay(c.date)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">{m.talkPct}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                        {m.questions}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                        {m.longestTurn} palabras
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {theirs.length > 0 && (
        <Card
          title="Tendencia entre períodos (calculada)"
          action={
            <label className="flex items-center gap-1 text-xs text-ink-secondary">
              comparar antes y desde
              <input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="input py-0.5 text-xs"
              />
            </label>
          }
        >
          <table className="w-full text-sm" data-sales-trend>
            <thead className="text-xs text-ink-secondary">
              <tr>
                <th className="px-2 py-1 text-left font-semibold">Métrica</th>
                <th className="px-2 py-1 text-right font-semibold">
                  Antes ({trend.before.calls} llamadas)
                </th>
                <th className="px-2 py-1 text-right font-semibold">
                  Después ({trend.after.calls} llamadas)
                </th>
                <th className="px-2 py-1 text-right font-semibold">Resultado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {trend.rows.map((r) => (
                <tr key={r.metric}>
                  <td className="px-2 py-1.5 text-ink">{r.metric}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{r.before}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{r.after}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Badge tone={verdictTone[r.verdict]}>{r.verdict}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(trend.before.calls < 2 || trend.after.calls < 2) && (
            <p className="mt-2 text-xs text-warning">
              Con menos de dos llamadas en un período la comparación no es concluyente.
            </p>
          )}
        </Card>
      )}
      {theirs.length > 0 && (
        <Card
          title="Coaching del asistente"
          action={
            <div className="flex gap-1.5">
              <SmallButton primary disabled={running !== null} onClick={() => void run("coaching")}>
                {running === "coaching" ? "Analizando…" : "Coaching individual"}
              </SmallButton>
              <SmallButton disabled={running !== null} onClick={() => void run("trends")}>
                {running === "trends" ? "Comparando…" : "Explicar la tendencia"}
              </SmallButton>
            </div>
          }
        >
          {artifact ? (
            <ResultView artifact={artifact} />
          ) : (
            <Empty>
              Pide el coaching: señala momentos concretos de las llamadas y qué probar en la
              próxima.
            </Empty>
          )}
        </Card>
      )}
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
          <SmallButton primary={!loaded} disabled={loading} onClick={() => void reset()}>
            {loading ? "Cargando…" : loaded ? "Reiniciar demo" : "Cargar la demo"}
          </SmallButton>
        }
      >
        <p className="text-sm text-ink-secondary">
          Un recorrido con un solo cliente y una sola oportunidad, de principio a fin. Todos los
          datos son <strong className="text-warning">ficticios</strong> y llevan la marca{" "}
          <DemoTag />: no se mezclan con tus clientes y funcionan sin credenciales externas.
          «Reiniciar demo» los devuelve a su estado original.
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
