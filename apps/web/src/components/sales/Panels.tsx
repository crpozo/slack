import {
  callMetrics,
  FORECAST_LABEL,
  forecastOf,
  inForecast,
  isOpenStage,
  leadsSales,
  oppGaps,
  SALES_SERVICE_LABEL,
  SALES_STAGE_LABEL,
  salesMoney,
  salesPriorities,
  type ForecastFilter,
  type ForecastTotals,
  type SalesAccount,
  type SalesCall,
  type SalesMeeting,
  type SalesOpportunity,
  type SalesRecord,
  type SalesService,
} from "@mindfultech/shared";
import { useMemo, useState } from "react";
import { useChat } from "../../store";
import { useSales } from "../../store/sales";
import { ChangeLine } from "./Accounts";
import { FlowButton } from "./Result";
import { Badge, Card, DemoTag, Empty, fmtDateTime, fmtDay, Stat, useSalesNav } from "./ui";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): the rep's panel, the forecast review and the leadership
// panel. Every number here is computed by `@mindfultech/shared` from the
// records the person may see, and opens the records that add up to it.
// ---------------------------------------------------------------------------

const PERIODS = [
  ["30dias", "Próximos 30 días"],
  ["mes", "Este mes"],
  ["proximo", "Próximo mes"],
  ["trimestre", "Este trimestre"],
  ["todo", "Todo"],
] as const;
type Period = (typeof PERIODS)[number][0];

function periodRange(period: Period, now = new Date()): Pick<ForecastFilter, "from" | "to"> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = (yy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  // From the start of this month (what should have closed already) to 30 days ahead.
  if (period === "30dias") {
    return {
      from: day(y, m, 1),
      to: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    };
  }
  if (period === "mes") return { from: day(y, m, 1), to: day(y, m + 1, 0) };
  if (period === "proximo") return { from: day(y, m + 1, 1), to: day(y, m + 2, 0) };
  if (period === "trimestre") {
    const q = Math.floor(m / 3) * 3;
    return { from: day(y, q, 1), to: day(y, q + 3, 0) };
  }
  return {};
}

function useFilters() {
  const me = useChat((s) => s.me);
  const people = useSales((s) => s.state?.people ?? []);
  const records = useSales((s) => s.state?.records ?? []);
  const [period, setPeriod] = useState<Period>("30dias");
  const [ownerId, setOwnerId] = useState("");
  // Owners that appear in the records (the demo's rep isn't a person of the team).
  const owners = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of records)
      if (r.kind === "opportunity" || r.kind === "account") seen.set(r.ownerId, r.ownerName);
    for (const p of people) if (seen.has(p.userId)) seen.set(p.userId, p.name);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [records, people]);
  const filter: ForecastFilter = { ...periodRange(period), ...(ownerId && { ownerId }) };
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="tablist"
        aria-label="Periodo"
        className="flex gap-1 rounded-lg bg-surface-hover p-1"
      >
        {PERIODS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={period === id}
            onClick={() => setPeriod(id)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${period === id ? "bg-surface text-ink shadow" : "text-ink-secondary hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <select
        value={ownerId}
        onChange={(e) => setOwnerId(e.target.value)}
        aria-label="Responsable"
        className="input w-auto text-sm"
      >
        <option value="">{leadsSales(me?.role) ? "Todo el equipo" : "Todo lo que veo"}</option>
        {owners.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
  return { filter, controls, ownerId, setOwnerId };
}

/** The opportunities behind a number. */
function OppTable({
  title,
  opps,
  records,
  onClose,
}: Readonly<{
  title: string;
  opps: SalesOpportunity[];
  records: SalesRecord[];
  onClose?: () => void;
}>) {
  const nav = useSalesNav();
  const accountOf = (id: string) =>
    records.find((r): r is SalesAccount => r.kind === "account" && r.id === id);
  const now = Date.now();
  return (
    <Card
      title={title}
      action={
        onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-ink-secondary hover:text-ink"
          >
            Cerrar ✕
          </button>
        )
      }
    >
      {opps.length === 0 ? (
        <Empty>Ninguna oportunidad.</Empty>
      ) : (
        <ul className="divide-y divide-line" data-sales-drill>
          {opps.map((o) => {
            const gaps = oppGaps(o, records, now);
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => nav.open(o)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left hover:bg-surface-hover"
                  title="Abrir la oportunidad en su cliente"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                      {o.name}
                      {o.demo && <DemoTag />}
                    </span>
                    <span className="block text-xs text-ink-secondary">
                      {accountOf(o.accountId)?.name ?? "—"} · {o.ownerName} ·{" "}
                      {SALES_STAGE_LABEL[o.stage]} · cierre {fmtDay(o.closeDate)}
                    </span>
                    {gaps.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {gaps.map((g) => (
                          <Badge key={g.text} tone={g.severity === "riesgo" ? "bad" : "warn"}>
                            {g.text}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                    {salesMoney(o.amount, o.currency)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

type Bucket = keyof Omit<ForecastTotals, "currency">;
const BUCKETS: Bucket[] = ["won", "commit", "best_case", "pipeline"];

function ForecastTotalsGrid({
  totals,
  onPick,
}: Readonly<{ totals: ForecastTotals[]; onPick: (title: string, ids: string[]) => void }>) {
  if (totals.length === 0)
    return <Empty>No hay oportunidades con fecha de cierre en este periodo.</Empty>;
  return (
    <div className="space-y-2">
      {totals.map((t) => (
        <div
          key={t.currency}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          data-sales-forecast={t.currency}
        >
          {BUCKETS.map((b) => (
            <Stat
              key={b}
              label={`${FORECAST_LABEL[b]}${totals.length > 1 ? ` · ${t.currency}` : ""}`}
              value={salesMoney(t[b].amount, t.currency)}
              hint={`${t[b].ids.length} ${t[b].ids.length === 1 ? "oportunidad" : "oportunidades"}`}
              tone={b === "won" ? "good" : undefined}
              onClick={() => onPick(`${FORECAST_LABEL[b]} · ${t.currency}`, t[b].ids)}
            />
          ))}
        </div>
      ))}
      {totals.length > 1 && (
        <p className="text-xs text-ink-secondary">Los totales no se suman entre monedas.</p>
      )}
    </div>
  );
}

export function ForecastTab() {
  const records = useSales((s) => s.state?.records ?? []);
  const { filter, controls } = useFilters();
  const [drill, setDrill] = useState<{ title: string; ids: string[] } | null>(null);
  const opps = useMemo(
    () => records.filter((r): r is SalesOpportunity => r.kind === "opportunity"),
    [records],
  );
  const inPeriod = opps.filter((o) => inForecast(o, filter));
  const totals = forecastOf(opps, filter);
  const now = Date.now();
  const flagged = inPeriod
    .filter(
      (o) =>
        isOpenStage(o.stage) &&
        o.forecastCategory !== "omitted" &&
        o.forecastCategory !== "pipeline",
    )
    .map((o) => ({ o, gaps: oppGaps(o, records, now) }))
    .filter((x) => x.gaps.length > 0)
    .sort((a, b) => b.o.amount - a.o.amount);
  return (
    <div className="space-y-3" data-sales-tab="pronostico">
      {controls}
      <ForecastTotalsGrid totals={totals} onPick={(title, ids) => setDrill({ title, ids })} />
      {drill && (
        <OppTable
          title={`${drill.title}: ${drill.ids.length} ${drill.ids.length === 1 ? "oportunidad" : "oportunidades"}`}
          opps={opps.filter((o) => drill.ids.includes(o.id))}
          records={records}
          onClose={() => setDrill(null)}
        />
      )}
      <OppTable
        title={`En riesgo o sin evidencia entre lo comprometido y lo adicional (${flagged.length})`}
        opps={flagged.map((x) => x.o)}
        records={records}
      />
      <p className="text-xs text-ink-secondary">
        Cada oportunidad cuenta una sola vez, en su categoría de pronóstico (o como cerrada ganada).
        Las perdidas y las que no tienen fecha de cierre en el periodo no entran.
      </p>
    </div>
  );
}

export function DashboardTab() {
  const nav = useSalesNav();
  const me = useChat((s) => s.me);
  const records = useSales((s) => s.state?.records ?? []);
  const changes = useSales((s) => s.state?.changes ?? []);
  // The demo's portfolio belongs to its fictitious rep: shown to everyone as an example.
  const mine = useMemo(
    () => records.filter((r) => r.ownerId === me?.userId || r.demo),
    [records, me?.userId],
  );
  const now = Date.now();
  const accounts = mine.filter((r): r is SalesAccount => r.kind === "account");
  const opps = mine.filter(
    (r): r is SalesOpportunity => r.kind === "opportunity" && isOpenStage(r.stage),
  );
  const priorities = useMemo(
    () => salesPriorities(mine, changes, null, now).slice(0, 6),
    [mine, changes, now],
  );
  const atRisk = opps.filter((o) => oppGaps(o, records, now).some((g) => g.severity === "riesgo"));
  const upcoming = mine
    .filter((r): r is SalesMeeting => r.kind === "meeting" && Date.parse(r.date) >= now)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  const actions = opps
    .filter((o) => o.nextStep)
    .sort((a, b) => (a.nextStepDate || "9").localeCompare(b.nextStepDate || "9"))
    .slice(0, 5);
  const ids = new Set(mine.map((r) => r.id));
  const recent = changes
    .filter((c) => ids.has(c.recordId) && c.at >= now - 14 * 86_400_000)
    .slice(0, 8);
  const [drill, setDrill] = useState<"abiertas" | "riesgo" | null>(null);
  const total = [...new Set(opps.map((o) => o.currency))]
    .map((cur) =>
      salesMoney(
        opps.filter((o) => o.currency === cur).reduce((n, o) => n + o.amount, 0),
        cur,
      ),
    )
    .join(" + ");

  if (accounts.length === 0) {
    return (
      <Empty>
        Aún no tienes clientes ni prospectos cargados.{" "}
        <button
          type="button"
          className="font-semibold text-primary"
          onClick={() => nav.go({ tab: "demo" })}
        >
          Carga la demo guiada
        </button>{" "}
        o agrega tu primer cliente en Clientes.
      </Empty>
    );
  }
  return (
    <div className="space-y-3" data-sales-tab="panel">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Clientes en mi cartera"
          value={accounts.length}
          onClick={() => nav.go({ tab: "cuentas" })}
        />
        <Stat
          label="Oportunidades abiertas"
          value={opps.length}
          hint={total || undefined}
          onClick={() => setDrill("abiertas")}
        />
        <Stat
          label="En riesgo"
          value={atRisk.length}
          tone={atRisk.length ? "bad" : "good"}
          onClick={() => setDrill("riesgo")}
        />
        <Stat label="Reuniones próximas" value={upcoming.length} />
      </div>
      {drill && (
        <OppTable
          title={drill === "riesgo" ? "Oportunidades en riesgo" : "Oportunidades abiertas"}
          opps={drill === "riesgo" ? atRisk : opps}
          records={records}
          onClose={() => setDrill(null)}
        />
      )}
      <Card title="Prioridades de la semana">
        {priorities.length === 0 ? (
          <Empty>Nada urgente esta semana.</Empty>
        ) : (
          <ol className="space-y-2" data-sales-priorities>
            {priorities.map((p, i) => {
              const account = accounts.find((a) => a.id === p.accountId);
              if (!account) return null;
              return (
                <li key={p.accountId} className="rounded-lg border border-line p-2.5">
                  <button
                    type="button"
                    onClick={() => nav.go({ tab: "cuentas", account: account.id })}
                    className="flex items-center gap-2 text-sm font-semibold text-ink hover:underline"
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-xs text-primary">
                      {i + 1}
                    </span>
                    {account.name}
                    {account.demo && <DemoTag />}
                  </button>
                  <ul className="mt-1 space-y-0.5 pl-7">
                    {p.reasons.slice(0, 5).map((r) => (
                      <li key={`${r.recordId}-${r.text}`} className="text-xs text-ink-secondary">
                        <button
                          type="button"
                          onClick={() =>
                            nav.go({ tab: "cuentas", account: account.id, focus: r.recordId })
                          }
                          className="text-left hover:text-ink hover:underline"
                          title="Abrir el registro que lo justifica"
                        >
                          ↗ {r.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="Próximas reuniones"
          action={
            upcoming.length > 1 && <FlowButton flow="agenda" label="Agenda con preparación" />
          }
        >
          {upcoming.length === 0 ? (
            <Empty>Sin reuniones agendadas.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => nav.open(m)}
                    className="min-w-0 text-left text-sm text-ink hover:underline"
                  >
                    {m.title}
                    <span className="block text-xs text-ink-secondary">{fmtDateTime(m.date)}</span>
                  </button>
                  <FlowButton
                    flow="prep"
                    label="Preparar"
                    refs={{
                      accountId: m.accountId,
                      meetingId: m.id,
                      ...(m.opportunityId && { opportunityId: m.opportunityId }),
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Próximas acciones">
          {actions.length === 0 ? (
            <Empty>Ninguna oportunidad tiene un próximo paso.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {actions.map((o) => (
                <li key={o.id} className="py-1.5">
                  <button
                    type="button"
                    onClick={() => nav.open(o)}
                    className="text-left text-sm text-ink hover:underline"
                  >
                    {o.nextStep}
                    <span className="block text-xs text-ink-secondary">
                      {o.name} · {o.nextStepDate ? fmtDay(o.nextStepDate) : "sin fecha"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Cambios recientes (14 días)">
        {recent.length === 0 ? (
          <Empty>Sin cambios.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((c) => (
              <ChangeLine
                key={c.id}
                change={c}
                onOpen={() => nav.go({ tab: "cuentas", account: c.accountId, focus: c.recordId })}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function LeadershipTab() {
  const nav = useSalesNav();
  const me = useChat((s) => s.me);
  const records = useSales((s) => s.state?.records ?? []);
  const { filter, controls, setOwnerId } = useFilters();
  const [drill, setDrill] = useState<{ title: string; ids: string[] } | null>(null);
  const now = Date.now();
  const opps = useMemo(
    () => records.filter((r): r is SalesOpportunity => r.kind === "opportunity"),
    [records],
  );
  if (!leadsSales(me?.role)) {
    return (
      <Empty>
        El panel de liderazgo es para los admins. Tu cartera está en «Mi panel» y tu pronóstico en
        «Pronóstico».
      </Empty>
    );
  }
  const scoped = opps.filter((o) => inForecast(o, filter));
  const open = scoped.filter((o) => isOpenStage(o.stage));
  const risky = open.filter((o) => oppGaps(o, records, now).some((g) => g.severity === "riesgo"));
  const strategic = records.filter(
    (r): r is SalesAccount =>
      r.kind === "account" && r.strategic && (!filter.ownerId || r.ownerId === filter.ownerId),
  );
  const calls = records.filter((r): r is SalesCall => r.kind === "call");
  const reps = [...new Map(opps.map((o) => [o.ownerId, o.ownerName])).entries()].map(
    ([id, name]) => {
      const theirs = scoped.filter((o) => o.ownerId === id);
      const theirOpen = theirs.filter((o) => isOpenStage(o.stage));
      const theirCalls = calls.filter((c) => c.ownerId === id);
      const metrics = theirCalls.map(callMetrics);
      const avg = (pick: (m: (typeof metrics)[number]) => number) =>
        metrics.length
          ? Math.round(metrics.reduce((n, m) => n + pick(m), 0) / metrics.length)
          : null;
      return {
        id,
        name,
        open: theirOpen,
        totals: forecastOf(theirs),
        risky: theirOpen.filter((o) =>
          oppGaps(o, records, now).some((g) => g.severity === "riesgo"),
        ),
        calls: theirCalls.length,
        talk: avg((m) => m.talkPct),
        questions: avg((m) => m.questions),
      };
    },
  );
  const byService = ["desarrollo", "ia", "discovery", "soporte", "equipo", ""]
    .map((service) => {
      const theirs = open.filter((o) => o.service === service);
      return {
        label: service ? SALES_SERVICE_LABEL[service as SalesService] : "Sin servicio definido",
        ids: theirs.map((o) => o.id),
        amount: [...new Set(theirs.map((o) => o.currency))]
          .map((cur) =>
            salesMoney(
              theirs.filter((o) => o.currency === cur).reduce((n, o) => n + o.amount, 0),
              cur,
            ),
          )
          .join(" + "),
      };
    })
    .filter((row) => row.ids.length > 0);
  const sum = (list: ForecastTotals[], b: Bucket) =>
    list.map((t) => salesMoney(t[b].amount, t.currency)).join(" + ") || "—";

  return (
    <div className="space-y-3" data-sales-tab="liderazgo">
      {controls}
      <ForecastTotalsGrid
        totals={forecastOf(opps, filter)}
        onPick={(title, ids) => setDrill({ title, ids })}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          label="Oportunidades abiertas"
          value={open.length}
          onClick={() => setDrill({ title: "Oportunidades abiertas", ids: open.map((o) => o.id) })}
        />
        <Stat
          label="En riesgo"
          value={risky.length}
          tone={risky.length ? "bad" : "good"}
          onClick={() => setDrill({ title: "En riesgo", ids: risky.map((o) => o.id) })}
        />
        <Stat label="Clientes estratégicos" value={strategic.length} />
      </div>
      {drill && (
        <OppTable
          title={`${drill.title}: ${drill.ids.length}`}
          opps={opps.filter((o) => drill.ids.includes(o.id))}
          records={records}
          onClose={() => setDrill(null)}
        />
      )}
      <Card title="Clientes estratégicos">
        {strategic.length === 0 ? (
          <Empty>Ningún cliente marcado como estratégico.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {strategic.map((a) => {
              const theirs = opps.filter((o) => o.accountId === a.id && isOpenStage(o.stage));
              const risk = theirs
                .flatMap((o) => oppGaps(o, records, now))
                .filter((g) => g.severity === "riesgo");
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => nav.go({ tab: "cuentas", account: a.id })}
                    className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left hover:bg-surface-hover"
                  >
                    <span className="min-w-0 text-sm font-medium text-ink">
                      {a.name} {a.demo && <DemoTag />}
                      <span className="block text-xs font-normal text-ink-secondary">
                        {a.ownerName} · {theirs.length}{" "}
                        {theirs.length === 1 ? "oportunidad abierta" : "oportunidades abiertas"}
                      </span>
                    </span>
                    <Badge tone={risk.length ? "bad" : "good"}>
                      {risk.length
                        ? `${risk.length} ${risk.length === 1 ? "riesgo" : "riesgos"}`
                        : "Sin riesgos"}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Por línea de servicio (oportunidades abiertas)">
        <ul className="divide-y divide-line" data-sales-services>
          {byService.map((row) => (
            <li key={row.label}>
              <button
                type="button"
                onClick={() => setDrill({ title: row.label, ids: row.ids })}
                className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-sm hover:bg-surface-hover"
              >
                <span className="text-ink">
                  {row.label}{" "}
                  <span className="text-xs text-ink-secondary">
                    · {row.ids.length} {row.ids.length === 1 ? "oportunidad" : "oportunidades"}
                  </span>
                </span>
                <span className="font-semibold tabular-nums text-ink">{row.amount}</span>
              </button>
            </li>
          ))}
        </ul>
        {byService.length === 0 && <Empty>Sin oportunidades abiertas en el periodo.</Empty>}
      </Card>
      <Card title="Desempeño del equipo">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-sales-team>
            <thead className="text-xs text-ink-secondary">
              <tr>
                {[
                  "Responsable",
                  "Comprometido",
                  "Adicional",
                  "Abiertas",
                  "En riesgo",
                  "Llamadas",
                  "Habla (%)",
                  "Preguntas",
                ].map((h, i) => (
                  <th
                    key={h}
                    className={`px-2 py-1.5 font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {reps.map((r) => (
                <tr key={r.id}>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      className="font-medium text-ink hover:underline"
                      onClick={() => setOwnerId(r.id)}
                      title="Filtrar por este responsable"
                    >
                      {r.name}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                    {sum(r.totals, "commit")}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                    {sum(r.totals, "best_case")}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      className="tabular-nums text-ink hover:underline"
                      onClick={() =>
                        setDrill({ title: `Abiertas de ${r.name}`, ids: r.open.map((o) => o.id) })
                      }
                    >
                      {r.open.length}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      className={`tabular-nums hover:underline ${r.risky.length ? "font-semibold text-error" : "text-ink"}`}
                      onClick={() =>
                        setDrill({ title: `En riesgo de ${r.name}`, ids: r.risky.map((o) => o.id) })
                      }
                    >
                      {r.risky.length}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      className="tabular-nums text-ink hover:underline"
                      onClick={() => nav.go({ tab: "coaching", focus: r.id })}
                    >
                      {r.calls}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{r.talk ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                    {r.questions ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {reps.length === 0 && <Empty>Sin oportunidades todavía.</Empty>}
      </Card>
    </div>
  );
}
