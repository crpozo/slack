import type { PlatformMetrics, PlatformReport } from "@mindfultech/shared";
import { useEffect, type ReactNode } from "react";
import { usePlatformInsights } from "../store/platformInsights";
import { MenuIcon, RefreshIcon, SparklesIcon } from "./icons";

// ---------------------------------------------------------------------------
// Platform Insights (Phase 64): how the team uses the app in the last 30
// days, and what the AI would improve. Only its owners reach this view. In
// Spanish, as the owner reads it.
// ---------------------------------------------------------------------------

const CARD = "rounded-2xl border border-line bg-surface-sidebar p-4 sm:p-5";
const KICKER = "font-mono text-[11px] uppercase tracking-[0.14em] text-primary";
const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const IMPACT: Record<string, string> = {
  alto: "bg-error/15 text-error",
  medio: "bg-warning/15 text-warning",
  bajo: "bg-surface-hover text-ink-secondary",
};
const dateFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", timeZone: "UTC" });
const shortDate = (date: string) => dateFmt.format(new Date(`${date}T00:00:00Z`));
const whenFmt = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function PlatformInsightsView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const { allowed, status, report, generating, error, checkAccess, load, generate } =
    usePlatformInsights();
  useEffect(() => {
    document.title = "Insights · MindfulTech";
    void checkAccess();
  }, [checkAccess]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface" data-platform-insights>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 pb-24 pt-6 sm:px-8 sm:pt-10">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2">
              {onOpenSidebar && (
                <button
                  type="button"
                  onClick={onOpenSidebar}
                  className="-ml-1 rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
                  aria-label="Open menu"
                >
                  <MenuIcon />
                </button>
              )}
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-ink sm:text-3xl">Insights</h1>
                <p className="mt-1 text-sm text-ink-secondary">
                  Cómo usa el equipo la plataforma y qué mejorar.
                  {report &&
                    ` ${shortDate(report.metrics.from)} – ${shortDate(report.metrics.to)} · actualizado ${whenFmt.format(report.generatedAt)}`}
                </p>
              </div>
            </div>
            {allowed && (
              <button
                type="button"
                onClick={() => void generate()}
                disabled={generating}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-[13px] font-semibold text-on-primary transition hover:brightness-110 disabled:opacity-70"
              >
                <RefreshIcon className={generating ? "animate-spin" : ""} aria-hidden="true" />
                {generating ? "Analizando…" : report ? "Analizar de nuevo" : "Analizar ahora"}
              </button>
            )}
          </header>

          {allowed === false && (
            <p className={CARD} role="status">
              Esta sección no está disponible para tu cuenta.
            </p>
          )}
          {error && (
            <p
              className="rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm text-ink"
              role="alert"
            >
              {error}
            </p>
          )}
          {generating && (
            <p
              className="rounded-xl border border-primary/30 bg-primary/[0.08] px-4 py-3 text-sm text-ink"
              role="status"
            >
              Leyendo los datos de la plataforma y escribiendo el análisis. Suele tardar cerca de un
              minuto; puedes cambiar de página mientras tanto.
            </p>
          )}
          {allowed && status === "loading" && !report && (
            <div className="grid gap-4 sm:grid-cols-3" aria-busy="true" aria-label="Cargando">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface-sidebar" />
              ))}
            </div>
          )}
          {allowed && status === "ready" && !report && !generating && (
            <div className={`${CARD} text-center`}>
              <SparklesIcon className="mx-auto text-3xl text-primary" aria-hidden="true" />
              <p className="mt-2 text-sm text-ink">
                Todavía no hay un informe. Pulsa <strong>Analizar ahora</strong> para leer los
                últimos 30 días.
              </p>
            </div>
          )}
          {allowed && report && <Report report={report} />}
        </div>
      </div>
    </div>
  );
}

function Report({ report }: Readonly<{ report: PlatformReport }>) {
  const { metrics: m, analysis } = report;
  const change =
    m.messages.previous > 0
      ? Math.round(((m.messages.total - m.messages.previous) / m.messages.previous) * 100)
      : null;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-6" aria-label="Resumen en números">
        <Stat
          label="Mensajes"
          value={m.messages.total}
          note={
            change === null
              ? "sin periodo anterior"
              : `${change >= 0 ? "+" : ""}${change}% vs. 30 días antes`
          }
        />
        <Stat
          label="Personas activas"
          value={`${m.people.active}/${m.people.total}`}
          note={`${m.people.guests} externos`}
        />
        <Stat
          label="Canales activos"
          value={`${m.channels.active}/${m.channels.total}`}
          note={`${m.channels.quiet.length} sin mensajes`}
        />
        <Stat
          label="Tareas abiertas"
          value={m.tasks.open}
          note={`${m.tasks.stale} sin tocar en 14 días`}
        />
        <Stat
          label="Tareas terminadas"
          value={m.tasks.done}
          note={
            m.tasks.medianDaysToDone === null
              ? `${m.tasks.created} creadas`
              : `mediana ${m.tasks.medianDaysToDone} días`
          }
        />
        <Stat
          label="Horas registradas"
          value={m.time.hours}
          note={
            m.time.cost === null
              ? `${m.calls.withNotes} llamadas con notas`
              : `$${m.time.cost.toLocaleString("es")} de costo`
          }
        />
      </section>

      {analysis ? (
        <>
          <section className={`${CARD} border-primary/30`} aria-label="Análisis">
            <span className={KICKER}>Análisis de la IA</span>
            <p className="mt-2 text-[15px] leading-relaxed text-ink [text-wrap:pretty]">
              {analysis.summary}
            </p>
          </section>
          <section aria-label="Recomendaciones" className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink">Qué mejorar</h2>
            <ol className="grid gap-3 lg:grid-cols-2">
              {analysis.recommendations.map((r, i) => (
                <li key={`${i}-${r.title}`} className={`flex flex-col gap-2 ${CARD}`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[15px] font-semibold leading-snug text-ink">
                      {i + 1}. {r.title}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${IMPACT[r.impact] ?? IMPACT.medio}`}
                    >
                      Impacto {r.impact}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed text-ink-secondary">{r.why}</p>
                  <p className="border-l-2 border-primary pl-3 text-sm leading-relaxed text-ink/90">
                    <span className="font-semibold text-primary">Cómo: </span>
                    {r.how}
                  </p>
                </li>
              ))}
            </ol>
          </section>
          <section className="grid gap-3 lg:grid-cols-3">
            <List title="Va bien" tone="text-success" items={analysis.wins} />
            <List title="Riesgos" tone="text-error" items={analysis.risks} />
            <List title="Para preguntar al equipo" tone="text-primary" items={analysis.questions} />
          </section>
        </>
      ) : (
        <p className={CARD} role="status">
          {report.analysisError ?? "El análisis con IA no está disponible; los números sí."}
        </p>
      )}

      <section className="grid gap-3 lg:grid-cols-2">
        <Bars
          title="Mensajes por día"
          values={m.messages.perDay.map((d) => d.count)}
          labels={m.messages.perDay.map((d) => shortDate(d.date))}
        />
        <Bars
          title="Mensajes por hora (hora de Ecuador)"
          values={m.messages.perHour}
          labels={m.messages.perHour.map((_, h) => `${h}:00`)}
          note={`${m.messages.outsideHours} fuera de 8:00–18:00 o en fin de semana · por día: ${m.messages.perWeekday
            .map((n, i) => `${WEEKDAYS[i]} ${n}`)
            .join(" · ")}`}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Table
          title="Personas"
          head={["Persona", "Mensajes", "Días activos", "Abiertas", "Hechas", "Horas"]}
          rows={m.people.list.map((p) => [
            `${p.name}${p.role === "guest" ? " (externo)" : ""}`,
            p.messages,
            p.activeDays,
            p.openTasks,
            p.tasksDone,
            p.hoursLogged,
          ])}
        />
        <Table
          title="Canales"
          head={["Canal", "Mensajes", "Personas", "Último mensaje"]}
          rows={m.channels.list.map((c) => [
            `${c.name}${c.hasExternals ? " · externos" : ""}`,
            c.messages,
            c.people,
            c.lastMessage ? shortDate(c.lastMessage) : "nunca",
          ])}
          footer={`Mensajes directos: ${m.messages.inDirectMessages} (en conjunto, sin detallar entre quiénes).`}
        />
      </section>

      <TasksAndTime metrics={m} />

      <p className="border-t border-line pt-4 text-xs leading-relaxed text-ink-secondary">
        Este informe usa solo conteos: quién escribió cuántos mensajes, dónde y cuándo; tareas por
        estado; horas registradas. No lee el texto de ningún mensaje, archivo, nota ni secreto. Un
        conteo no mide el trabajo de nadie: úsalo para hacer preguntas, no para sacar conclusiones
        sobre personas.
      </p>
    </>
  );
}

function TasksAndTime({ metrics: m }: Readonly<{ metrics: PlatformMetrics }>) {
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <div className={CARD}>
        <h3 className="text-sm font-bold text-ink">Tareas</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {(
            [
              ["Tableros", m.tasks.boards],
              ["Por hacer", m.tasks.byStatus.TODO ?? 0],
              ["En curso", m.tasks.byStatus.IN_PROGRESS ?? 0],
              ["Creadas en el periodo", m.tasks.created],
              ["Terminadas en el periodo", m.tasks.done],
              ["Abiertas sin responsable", m.tasks.unassigned],
            ] as Array<[string, number]>
          ).map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-1"
            >
              <dt className="text-ink-secondary">{label}</dt>
              <dd className="font-semibold tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Table
        title="Horas por canal"
        head={["Canal", "Horas", "Costo"]}
        rows={m.time.byChannel.map((c) => [
          c.name,
          c.hours,
          c.cost === null ? "sin tarifa" : `$${c.cost.toLocaleString("es")}`,
        ])}
        footer={
          m.time.byChannel.length === 0
            ? "Nadie registró horas en el periodo."
            : `${m.calls.withNotes} llamadas con notas de IA (${m.calls.minutes} min).`
        }
      />
    </section>
  );
}

function Stat({ label, value, note }: Readonly<{ label: string; value: ReactNode; note: string }>) {
  return (
    <div className={CARD}>
      <p className="text-xs text-ink-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-[11px] text-ink-secondary">{note}</p>
    </div>
  );
}

function List({ title, tone, items }: Readonly<{ title: string; tone: string; items: string[] }>) {
  return (
    <div className={CARD}>
      <h3 className={`text-sm font-bold ${tone}`}>{title}</h3>
      <ul className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-ink/90">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className={tone} aria-hidden="true">
              •
            </span>
            <span className="[text-wrap:pretty]">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A small bar chart: one bar per value, its number on hover. */
function Bars({
  title,
  values,
  labels,
  note,
}: Readonly<{ title: string; values: number[]; labels: string[]; note?: string }>) {
  const max = Math.max(1, ...values);
  return (
    <div className={CARD}>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <div className="mt-3 flex h-28 items-end gap-[3px]" role="img" aria-label={title}>
        {values.map((value, i) => (
          <div
            key={i}
            className="min-w-0 flex-1 rounded-t bg-primary/70 transition hover:bg-primary"
            style={{ height: `${Math.max(value > 0 ? 4 : 1, (value / max) * 100)}%` }}
            title={`${labels[i]}: ${value}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-secondary">
        <span>{labels[0]}</span>
        <span>{labels.at(-1)}</span>
      </div>
      {note && <p className="mt-2 text-xs text-ink-secondary">{note}</p>}
    </div>
  );
}

function Table({
  title,
  head,
  rows,
  footer,
}: Readonly<{
  title: string;
  head: string[];
  rows: Array<Array<string | number>>;
  footer?: string;
}>) {
  return (
    <div className={`${CARD} min-w-0`}>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <div className="mt-2 max-h-80 overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-sidebar text-xs text-ink-secondary">
            <tr>
              {head.map((h, i) => (
                <th key={h} className={`py-1.5 font-medium ${i > 0 ? "pl-3 text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-t border-line/60">
                {row.map((cell, i) => (
                  <td
                    key={i}
                    className={`py-1.5 ${i > 0 ? "pl-3 text-right tabular-nums text-ink-secondary" : "max-w-[14rem] truncate text-ink"}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <p className="mt-2 text-xs text-ink-secondary">{footer}</p>}
    </div>
  );
}
