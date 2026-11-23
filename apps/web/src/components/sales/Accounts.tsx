import {
  ACCOUNT_STATUS_LABEL,
  CONTACT_ROLE_LABEL,
  CRM_FIELD_LABEL,
  FORECAST_LABEL,
  isOpenStage,
  oppGaps,
  SALES_STAGE_LABEL,
  salesCsv,
  salesMoney,
  type SalesAccount,
  type SalesChange,
  type SalesContact,
  type SalesInput,
  type SalesMeeting,
  type SalesOpportunity,
  type SalesRecord,
} from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadBytes } from "../../lib/pptx";
import { useChat } from "../../store";
import { useSales } from "../../store/sales";
import { RecordForm, type RecordFormTarget } from "./RecordForm";
import { crmValue, FlowButton } from "./Result";
import { RoiModal } from "./Roi";
import { Badge, Card, DemoTag, Empty, fmtDateTime, fmtDay, SmallButton, useSalesNav } from "./ui";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): the accounts and, inside one, everything that hangs from
// it. The assistant's flows start where the work is: prepare a meeting from
// the meeting, its follow-up from its notes, the business case and the
// strategy from the opportunity, signals and first contact from the account.
// ---------------------------------------------------------------------------

const STATUS_TONE = {
  prospecto: "neutral",
  cliente: "good",
  en_riesgo: "bad",
  inactivo: "neutral",
} as const;

/** One change of the log, as a line. */
export function ChangeLine({
  change,
  onOpen,
}: Readonly<{ change: SalesChange; onOpen?: () => void }>) {
  const field =
    change.field === "creado" ? "Creado" : (CRM_FIELD_LABEL[change.field] ?? change.field);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm">
      <span className="w-24 shrink-0 text-xs tabular-nums text-ink-secondary">
        {fmtDay(new Date(change.at).toISOString())}
      </span>
      <span className="min-w-0 flex-1 text-ink">
        <button
          type="button"
          onClick={onOpen}
          className="font-medium hover:underline"
          title={`Abrir el registro (${change.recordId})`}
        >
          {change.label}
        </button>
        {" · "}
        {field}
        {change.field !== "creado" && (
          <>
            :{" "}
            <span className="text-ink-secondary line-through">
              {crmValue(change.field, change.from)}
            </span>{" "}
            → <strong>{crmValue(change.field, change.to)}</strong>
          </>
        )}
      </span>
      <span className="shrink-0 text-xs text-ink-secondary">{change.byName}</span>
    </li>
  );
}

function OpportunityCard({
  opp,
  account,
  records,
  focused,
  onEdit,
}: Readonly<{
  opp: SalesOpportunity;
  account: SalesAccount;
  records: SalesRecord[];
  focused: boolean;
  onEdit: () => void;
}>) {
  const [roi, setRoi] = useState(false);
  const gaps = useMemo(() => oppGaps(opp, records, Date.now()), [opp, records]);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const refs = { accountId: account.id, opportunityId: opp.id };
  return (
    <li
      ref={ref}
      data-sales-opp={opp.id}
      className={`rounded-xl border p-3 ${focused ? "border-primary" : "border-line"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
            {opp.name}
            <Badge
              tone={
                isOpenStage(opp.stage)
                  ? "info"
                  : opp.stage === "cerrada_ganada"
                    ? "good"
                    : "neutral"
              }
            >
              {SALES_STAGE_LABEL[opp.stage]}
            </Badge>
            {isOpenStage(opp.stage) && <Badge>{FORECAST_LABEL[opp.forecastCategory]}</Badge>}
          </p>
          <p className="text-xs text-ink-secondary">
            {opp.ownerName} · cierre {fmtDay(opp.closeDate)}
            {opp.nextStep
              ? ` · próximo paso: ${opp.nextStep}${opp.nextStepDate ? ` (${fmtDay(opp.nextStepDate)})` : ""}`
              : ""}
          </p>
        </div>
        <p className="text-lg font-bold tabular-nums text-ink" data-sales-amount>
          {salesMoney(opp.amount, opp.currency)}
        </p>
      </div>
      {gaps.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Riesgos y evidencia faltante">
          {gaps.map((g) => (
            <li key={g.text}>
              <Badge tone={g.severity === "riesgo" ? "bad" : "warn"}>{g.text}</Badge>
            </li>
          ))}
        </ul>
      )}
      {(opp.criteria || opp.process || opp.risks) && (
        <dl className="mt-2 space-y-0.5 text-xs text-ink-secondary">
          {opp.criteria && (
            <div>
              <dt className="inline font-semibold">Criterios: </dt>
              <dd className="inline">{opp.criteria}</dd>
            </div>
          )}
          {opp.process && (
            <div>
              <dt className="inline font-semibold">Proceso: </dt>
              <dd className="inline">{opp.process}</dd>
            </div>
          )}
          {opp.risks && (
            <div>
              <dt className="inline font-semibold">Riesgos: </dt>
              <dd className="inline">{opp.risks}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <FlowButton flow="strategy" label="Estrategia" refs={refs} primary />
        <SmallButton onClick={() => setRoi(true)}>Caso de negocio y ROI</SmallButton>
        <FlowButton
          flow="deck"
          label="Presentación comercial"
          refs={refs}
          prompt={{
            label: "Brief, propuesta aprobada o datos para la presentación, y para quién es",
            placeholder:
              "Audiencia: gerente financiero.\nPega aquí el brief o la propuesta aprobada…",
          }}
        />
        <FlowButton
          flow="competitive"
          label="Inteligencia competitiva"
          refs={refs}
          prompt={{
            label: "Criterios de compra del cliente y proveedores a comparar",
            placeholder: "Criterios: integración con ERP, soporte local, costo total…",
          }}
        />
        <SmallButton onClick={onEdit}>Editar</SmallButton>
      </div>
      {roi && <RoiModal opportunity={opp} account={account} onClose={() => setRoi(false)} />}
    </li>
  );
}

function AccountDetail({
  account,
  records,
}: Readonly<{ account: SalesAccount; records: SalesRecord[] }>) {
  const nav = useSalesNav();
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const save = useSales((s) => s.save);
  const changes = useSales((s) => s.state?.changes ?? []);
  const [form, setForm] = useState<RecordFormTarget | null>(null);
  const [since, setSince] = useState(() =>
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const of = <K extends SalesRecord["kind"]>(kind: K) =>
    records.filter(
      (r): r is Extract<SalesRecord, { kind: K }> =>
        r.kind === kind && "accountId" in r && r.accountId === account.id,
    );
  const opps = of("opportunity");
  const contacts = of("contact");
  const meetings = of("meeting").sort((a, b) => b.date.localeCompare(a.date));
  const ids = new Set([
    account.id,
    ...opps.map((o) => o.id),
    ...contacts.map((c) => c.id),
    ...meetings.map((m) => m.id),
  ]);
  const log = changes.filter(
    (c) => ids.has(c.recordId) && c.at >= Date.parse(`${since}T00:00:00Z`),
  );
  const watching = !!me && account.watchers.includes(me.userId);
  const defaults = { accountId: account.id };

  async function toggleWatch() {
    if (!me) return;
    try {
      await save({
        ...account,
        watchers: watching
          ? account.watchers.filter((w) => w !== me.userId)
          : [...account.watchers, me.userId],
      } as SalesInput);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar.", "error");
    }
  }

  return (
    <div className="space-y-3" data-sales-account={account.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            className="text-xs text-ink-secondary hover:text-ink"
            onClick={() => nav.go({ account: "", focus: "" })}
          >
            ← Todas las cuentas
          </button>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold text-ink">
            {account.name}
            <Badge tone={STATUS_TONE[account.status]}>{ACCOUNT_STATUS_LABEL[account.status]}</Badge>
            {account.strategic && <Badge tone="info">Estratégica</Badge>}
            {account.demo && <DemoTag />}
          </h2>
          <p className="text-xs text-ink-secondary">
            {[account.industry, account.size, account.country, `Responsable: ${account.ownerName}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {account.source && (
            <p className="text-xs text-ink-secondary">
              Fuente: {account.source}
              {account.sourceDate ? ` (${fmtDay(account.sourceDate)})` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <SmallButton onClick={() => void toggleWatch()} title="Tu lista de seguimiento">
            {watching ? "★ En seguimiento" : "☆ Seguir"}
          </SmallButton>
          <SmallButton onClick={() => setForm({ kind: "account", record: account })}>
            Editar
          </SmallButton>
        </div>
      </div>
      {account.notes && <p className="text-sm text-ink-secondary">{account.notes}</p>}
      <div className="flex flex-wrap gap-1.5">
        <FlowButton
          flow="outreach"
          label="Investigar y primer contacto"
          refs={{ accountId: account.id }}
          prompt={{
            label: "¿A quién le escribes y por qué canal? (también un socio o un referido)",
            placeholder: "Destinatario: Marta Salazar, Gerente de Operaciones. Nos refirió…",
          }}
        />
        <FlowButton
          flow="quotes"
          label="Buscar citas textuales"
          refs={{ accountId: account.id }}
          prompt={{
            label: "¿Sobre qué tema buscas evidencia?",
            placeholder: "integración con el ERP",
          }}
        />
      </div>

      <Card
        title={`Oportunidades (${opps.length})`}
        action={
          <SmallButton onClick={() => setForm({ kind: "opportunity", defaults })}>
            + Oportunidad
          </SmallButton>
        }
      >
        {opps.length === 0 ? (
          <Empty>Sin oportunidades.</Empty>
        ) : (
          <ul className="space-y-2">
            {opps.map((o) => (
              <OpportunityCard
                key={o.id}
                opp={o}
                account={account}
                records={records}
                focused={nav.focus === o.id}
                onEdit={() => setForm({ kind: "opportunity", record: o })}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={`Reuniones (${meetings.length})`}
        action={
          <SmallButton
            onClick={() =>
              setForm({
                kind: "meeting",
                defaults: { ...defaults, opportunityId: opps[0]?.id ?? "" },
              })
            }
          >
            + Reunión
          </SmallButton>
        }
      >
        {meetings.length === 0 ? (
          <Empty>Sin reuniones.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {meetings.map((m: SalesMeeting) => {
              const upcoming = Date.parse(m.date) > Date.now();
              const refs = {
                accountId: account.id,
                meetingId: m.id,
                ...(m.opportunityId && { opportunityId: m.opportunityId }),
              };
              return (
                <li
                  key={m.id}
                  data-sales-meeting={m.id}
                  className={`py-2 ${nav.focus === m.id ? "rounded-lg bg-primary/5 px-2" : ""}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                        {m.title}
                        <Badge tone={upcoming ? "info" : "neutral"}>
                          {upcoming ? "Próxima" : "Realizada"}
                        </Badge>
                      </p>
                      <p className="text-xs text-ink-secondary">
                        {fmtDateTime(m.date)}
                        {m.attendees ? ` · ${m.attendees}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <FlowButton flow="prep" label="Preparar" refs={refs} primary={upcoming} />
                      {m.notes ? (
                        <FlowButton
                          flow="followup"
                          label="Seguimiento"
                          refs={refs}
                          primary={!upcoming}
                        />
                      ) : (
                        <SmallButton
                          onClick={() => setForm({ kind: "meeting", record: m })}
                          title="Pega las notas o la transcripción para generar el seguimiento"
                        >
                          Agregar notas
                        </SmallButton>
                      )}
                      <SmallButton onClick={() => setForm({ kind: "meeting", record: m })}>
                        Editar
                      </SmallButton>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title={`Contactos (${contacts.length})`}
        action={
          <SmallButton onClick={() => setForm({ kind: "contact", defaults })}>
            + Contacto
          </SmallButton>
        }
      >
        {contacts.length === 0 ? (
          <Empty>Sin contactos.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {contacts.map((c: SalesContact) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-ink">
                    {c.name || "Persona por identificar"}
                  </span>
                  <span className="text-ink-secondary"> · {c.title || "sin cargo"}</span>
                  {c.email && <span className="text-ink-secondary"> · {c.email}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                  {!c.name && <Badge tone="warn">Falta identificar al contacto</Badge>}
                  {c.role && (
                    <Badge tone={c.role === "decisor" ? "good" : "neutral"}>
                      {CONTACT_ROLE_LABEL[c.role]}
                    </Badge>
                  )}
                  <SmallButton onClick={() => setForm({ kind: "contact", record: c })}>
                    Editar
                  </SmallButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Señales: qué cambió"
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1 text-xs text-ink-secondary">
              desde
              <input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="input py-0.5 text-xs"
              />
            </label>
            <FlowButton
              flow="signals"
              label="Resumir estado"
              refs={{ accountId: account.id }}
              extra={{ since }}
            />
          </div>
        }
      >
        {log.length === 0 ? (
          <Empty>Sin cambios registrados desde esa fecha.</Empty>
        ) : (
          <ul className="divide-y divide-line" data-sales-changes>
            {log.map((c) => (
              <ChangeLine key={c.id} change={c} onOpen={() => nav.go({ focus: c.recordId })} />
            ))}
          </ul>
        )}
      </Card>
      {form && <RecordForm target={form} onClose={() => setForm(null)} />}
    </div>
  );
}

export function AccountsTab() {
  const nav = useSalesNav();
  const me = useChat((s) => s.me);
  const records = useSales((s) => s.state?.records ?? []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"todas" | "mias" | "seguimiento" | "estrategicas">("todas");
  const [segment, setSegment] = useState("");
  const [creating, setCreating] = useState(false);
  const accounts = useMemo(
    () => records.filter((r): r is SalesAccount => r.kind === "account"),
    [records],
  );
  const account = accounts.find((a) => a.id === nav.accountId);
  const segments = [
    ...new Set(accounts.map((a) => a.segment || a.industry).filter(Boolean)),
  ].sort();
  const shown = accounts
    .filter(
      (a) =>
        (filter === "todas" ||
          (filter === "mias" && a.ownerId === me?.userId) ||
          (filter === "seguimiento" && !!me && a.watchers.includes(me.userId)) ||
          (filter === "estrategicas" && a.strategic)) &&
        (!segment || (a.segment || a.industry) === segment) &&
        (!query ||
          `${a.name} ${a.industry} ${a.country}`.toLowerCase().includes(query.toLowerCase())),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (account) return <AccountDetail account={account} records={records} />;

  const openOf = (id: string) =>
    records.filter(
      (r): r is SalesOpportunity =>
        r.kind === "opportunity" && r.accountId === id && isOpenStage(r.stage),
    );
  const exportCsv = () =>
    downloadBytes(
      "cuentas.csv",
      `\uFEFF${salesCsv(
        [
          "Empresa",
          "Sitio",
          "Industria",
          "Tamaño",
          "País",
          "Segmento",
          "Estado",
          "Responsable",
          "Fuente",
          "Fecha de la fuente",
        ],
        shown.map((a) => [
          a.name,
          a.domain,
          a.industry,
          a.size,
          a.country,
          a.segment,
          ACCOUNT_STATUS_LABEL[a.status],
          a.ownerName,
          a.source,
          a.sourceDate,
        ]),
      )}`,
      "text/csv;charset=utf-8",
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar cuenta…"
          aria-label="Buscar cuenta"
          className="input min-w-0 flex-1"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          aria-label="Filtro"
          className="input w-auto"
        >
          <option value="todas">Todas las que veo</option>
          <option value="mias">Mis cuentas</option>
          <option value="seguimiento">Mi lista de seguimiento</option>
          <option value="estrategicas">Estratégicas</option>
        </select>
        <select
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
          aria-label="Segmento"
          className="input w-auto"
        >
          <option value="">Todos los segmentos</option>
          {segments.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <SmallButton onClick={exportCsv} disabled={shown.length === 0}>
          Exportar CSV
        </SmallButton>
        <SmallButton primary onClick={() => setCreating(true)}>
          + Cuenta
        </SmallButton>
      </div>
      {shown.length === 0 ? (
        <Empty>
          No hay cuentas aquí. Crea una, impórtalas desde Prospección o carga la demo guiada.
        </Empty>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" data-sales-accounts>
          {shown.map((a) => {
            const open = openOf(a.id);
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => nav.go({ account: a.id })}
                  className="w-full rounded-xl border border-line p-3 text-left hover:border-primary/60 hover:bg-surface-hover"
                >
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                    {a.name}
                    <Badge tone={STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABEL[a.status]}</Badge>
                    {a.strategic && <Badge tone="info">Estratégica</Badge>}
                    {a.demo && <DemoTag />}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-secondary">
                    {[a.industry, a.country, a.ownerName].filter(Boolean).join(" · ")}
                  </span>
                  <span className="mt-1 block text-xs text-ink">
                    {open.length === 0
                      ? "Sin oportunidades abiertas"
                      : `${open.length} ${open.length === 1 ? "oportunidad abierta" : "oportunidades abiertas"} · ${[
                          ...new Set(open.map((o) => o.currency)),
                        ]
                          .map((cur) =>
                            salesMoney(
                              open
                                .filter((o) => o.currency === cur)
                                .reduce((n, o) => n + o.amount, 0),
                              cur,
                            ),
                          )
                          .join(" + ")}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <RecordForm target={{ kind: "account" }} onClose={() => setCreating(false)} />}
    </div>
  );
}
