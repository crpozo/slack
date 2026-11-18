import {
  calendarDay,
  canDeleteTimeEntry,
  canLogTime,
  costOf,
  formatMinutes,
  managesTimeRates,
  MAX_ENTRY_DESCRIPTION,
  parseDuration,
  timeLogCsv,
  timeTotals,
  type Channel,
  type TimeEntry,
} from "@mindfultech/shared";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { timeApi } from "../lib/tasksApi";
import { useChat } from "../store";
import { useTimeLog } from "../store/timeLog";
import { Avatar } from "./Avatar";
import { ClockIcon, TrashIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { GuestBadge } from "./UserPicker";

// ---------------------------------------------------------------------------
// Horas (Phase 60): a channel's time log. Whoever works on the project logs
// what they did each day; admins set each person's hourly rate here and see
// what it costs, live (the server tells an open log when it changes). In
// Spanish, as the team and its contractors write.
// Phase 70: the client's dashboard. An admin marks which externals of the
// channel are its clients and what each hour of each person is billed; a
// client opens Horas and sees, read-only, every entry and what it'll cost them
// (never the internal rates). Admins preview the same view in "Cliente".
// ---------------------------------------------------------------------------

const money = (amount: number) =>
  new Intl.NumberFormat("es-EC", { style: "currency", currency: "USD" }).format(amount);

const dayLabel = (date: string, today: string) => {
  if (date === today) return "Hoy";
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
};

/** `YYYY-MM-DD` of the Monday of `date`'s week. */
function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
}

type Range = "week" | "month" | "lastMonth" | "all";
const RANGES: Array<{ id: Range; label: string }> = [
  { id: "week", label: "Esta semana" },
  { id: "month", label: "Este mes" },
  { id: "all", label: "Todo" },
];
const CLIENT_RANGES: Array<{ id: Range; label: string }> = [
  { id: "month", label: "Este mes" },
  { id: "lastMonth", label: "Mes anterior" },
  { id: "week", label: "Esta semana" },
  { id: "all", label: "Todo" },
];

/** `YYYY-MM` of the month before `date`'s. */
function previousMonth(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y ?? 0, (m ?? 1) - 2, 1));
  return first.toISOString().slice(0, 7);
}

/** Whether a day (`YYYY-MM-DD`) falls in `range`, counted from `today`. */
function inRange(date: string, range: Range, today: string): boolean {
  if (range === "all") return true;
  if (range === "week") return date >= weekStart(today);
  if (range === "month") return date.startsWith(today.slice(0, 7));
  return date.startsWith(previousMonth(today));
}

const monthName = (yyyyMm: string) => {
  const [y, m] = yyyyMm.split("-").map(Number);
  return new Intl.DateTimeFormat("es", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    Date.UTC(y ?? 0, (m ?? 1) - 1, 1),
  );
};

/** What the period is called on the client's dashboard and its CSV. */
function periodLabel(range: Range, today: string): string {
  if (range === "month") return monthName(today.slice(0, 7));
  if (range === "lastMonth") return monthName(previousMonth(today));
  if (range === "week") return `semana del ${dayLabel(weekStart(today), "")}`;
  return "todo el proyecto";
}

function PeriodTabs({
  ranges,
  range,
  onChange,
}: Readonly<{ ranges: typeof RANGES; range: Range; onChange: (r: Range) => void }>) {
  return (
    <div role="tablist" aria-label="Periodo" className="flex gap-1 rounded-lg bg-surface-hover p-1">
      {ranges.map((r) => (
        <button
          key={r.id}
          type="button"
          role="tab"
          aria-selected={range === r.id}
          onClick={() => onChange(r.id)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
            range === r.id ? "bg-surface text-ink shadow" : "text-ink-secondary hover:text-ink"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Entries of a period grouped by day, newest first. */
function byDay(entries: TimeEntry[]): Array<[string, TimeEntry[]]> {
  const days = new Map<string, TimeEntry[]>();
  for (const e of entries) days.set(e.date, [...(days.get(e.date) ?? []), e]);
  return [...days.entries()];
}

function downloadCsv(name: string, csv: string) {
  // A BOM so Excel reads the accents right.
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The client's dashboard (Phase 70): read-only. The hours logged in the period,
 * what each person's hour is billed, the total to pay and every entry with its
 * amount; downloadable as a spreadsheet.
 */
export function ClientHours({
  channel,
  entries,
  billRates,
  nameOf,
  preview = false,
}: Readonly<{
  channel: Channel;
  entries: TimeEntry[] | null;
  billRates: Record<string, number>;
  nameOf: (e: Pick<TimeEntry, "userId" | "userName">) => string;
  /** An admin looking at what the client sees. */
  preview?: boolean;
}>) {
  const today = calendarDay(Date.now());
  const [range, setRange] = useState<Range>("month");
  const shown = useMemo(
    () => (entries ?? []).filter((e) => inRange(e.date, range, today)),
    [entries, range, today],
  );
  const totals = useMemo(() => timeTotals(shown, billRates), [shown, billRates]);
  const days = useMemo(() => byDay(shown), [shown]);
  const period = periodLabel(range, today);

  return (
    <div className="space-y-4" data-client-hours>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodTabs ranges={CLIENT_RANGES} range={range} onChange={setRange} />
        <button
          type="button"
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-surface-hover disabled:opacity-50"
          disabled={shown.length === 0}
          onClick={() =>
            downloadCsv(
              `horas-${channel.name}-${range === "all" ? "todo" : period.replace(/\s+/g, "-")}.csv`,
              timeLogCsv(shown, nameOf, billRates),
            )
          }
        >
          Descargar CSV
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-line px-3 py-2.5">
          <p className="text-xs text-ink-secondary">Horas registradas</p>
          <p className="text-xl font-bold tabular-nums text-ink" data-client-total-hours>
            {formatMinutes(totals.minutes)}
          </p>
        </div>
        <div className="rounded-xl border border-primary/40 bg-primary/10 px-3 py-2.5">
          <p className="text-xs text-ink-secondary">Total a cobrar</p>
          <p className="text-xl font-bold tabular-nums text-primary" data-client-total-cost>
            {money(totals.cost)}
          </p>
        </div>
        <div className="col-span-2 rounded-xl border border-line px-3 py-2.5 sm:col-span-1">
          <p className="text-xs text-ink-secondary">Periodo</p>
          <p className="truncate text-sm font-semibold text-ink">
            {period.charAt(0).toUpperCase() + period.slice(1)}
          </p>
          <p className="text-xs text-ink-secondary">
            {totals.byUser.length} {totals.byUser.length === 1 ? "persona" : "personas"} ·{" "}
            {shown.length} {shown.length === 1 ? "registro" : "registros"}
          </p>
        </div>
      </div>

      {totals.byUser.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm" aria-label="Por persona">
            <thead className="bg-surface-hover text-xs text-ink-secondary">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Persona</th>
                <th className="px-2 py-1.5 text-right font-semibold">Horas</th>
                <th className="hidden px-2 py-1.5 text-right font-semibold sm:table-cell">
                  Tarifa
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {totals.byUser.map((p) => (
                <tr key={p.userId}>
                  <td className="px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                      <Avatar name={nameOf(p)} size="sm" />
                      <span className="truncate">{nameOf(p)}</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink">
                    {formatMinutes(p.minutes)}
                  </td>
                  <td className="hidden px-2 py-2 text-right tabular-nums text-ink-secondary sm:table-cell">
                    {p.rate ? `${money(p.rate)}/h` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-primary">
                    {p.rate ? money(p.cost) : "Por definir"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-line bg-surface-hover/60">
              <tr>
                <td className="px-3 py-2 font-semibold text-ink">Total</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums text-ink">
                  {formatMinutes(totals.minutes)}
                </td>
                <td className="hidden sm:table-cell" />
                <td className="px-3 py-2 text-right font-bold tabular-nums text-primary">
                  {money(totals.cost)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {totals.unpricedMinutes > 0 && (
        <p className="text-xs text-warning" role="note">
          {formatMinutes(totals.unpricedMinutes)} aún sin tarifa
          {preview ? ": ponle el cobro por hora a esa persona arriba." : "; no se suman al total."}
        </p>
      )}

      {entries === null && (
        <p className="text-sm text-ink-secondary" aria-busy="true">
          Cargando…
        </p>
      )}
      {entries !== null && days.length === 0 && (
        <p className="text-sm text-ink-secondary">No hay horas registradas en este periodo.</p>
      )}
      {days.length > 0 && (
        <div className="space-y-3" aria-label="Detalle">
          <p className="text-sm font-semibold text-ink">Detalle</p>
          {days.map(([day, list]) => {
            const dayMinutes = list.reduce((n, e) => n + e.minutes, 0);
            const dayCost = list.reduce(
              (n, e) => n + costOf(e.minutes, billRates[e.userId] ?? 0),
              0,
            );
            return (
              <section key={day} aria-label={dayLabel(day, today)}>
                <h3 className="mb-1 flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                  <span>{dayLabel(day, today)}</span>
                  <span className="tabular-nums">
                    {formatMinutes(dayMinutes)} · {money(dayCost)}
                  </span>
                </h3>
                <ul className="space-y-1">
                  {list.map((e) => (
                    <li
                      key={e.entryId}
                      className="flex items-start gap-3 rounded-lg bg-white/[0.04] px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm text-ink">{e.description}</p>
                        <p className="text-xs text-ink-secondary">{nameOf(e)}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold tabular-nums text-ink">
                          {formatMinutes(e.minutes)}
                        </p>
                        <p className="text-xs tabular-nums text-primary">
                          {billRates[e.userId]
                            ? money(costOf(e.minutes, billRates[e.userId] ?? 0))
                            : "—"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {!preview && (
        <p className="text-xs text-ink-secondary">
          Vista de solo lectura. Los montos se calculan con la tarifa por hora acordada con
          MindfulTech.
        </p>
      )}
    </div>
  );
}

/**
 * Admins (Phase 70): who in the channel reviews the hours as its client, and
 * what each person's hour is billed to them.
 */
function ClientSettings({
  channel,
  people,
  billRates,
  clientIds,
  nameOf,
  onBillRate,
  onClients,
}: Readonly<{
  channel: Channel;
  people: Array<{ userId: string; userName: string }>;
  billRates: Record<string, number>;
  clientIds: string[];
  nameOf: (e: Pick<TimeEntry, "userId" | "userName">) => string;
  onBillRate: (userId: string, rate: number) => Promise<void>;
  onClients: (ids: string[]) => Promise<void>;
}>) {
  const users = useChat((s) => s.users);
  const externals = (channel.members ?? []).filter((id) => users[id]?.role === "guest");
  const [busy, setBusy] = useState(false);
  async function toggle(id: string) {
    if (busy) return;
    setBusy(true);
    const next = clientIds.includes(id) ? clientIds.filter((c) => c !== id) : [...clientIds, id];
    await onClients(next).finally(() => setBusy(false));
  }
  return (
    <div className="space-y-3 rounded-xl border border-line p-3" data-client-settings>
      <div>
        <p className="text-sm font-semibold text-ink">¿Quién es el cliente?</p>
        <p className="text-xs text-ink-secondary">
          Los externos marcados ven todas las horas de este canal y lo que se les cobrará, sin poder
          editar nada.
        </p>
        {externals.length === 0 ? (
          <p className="mt-2 text-xs text-ink-secondary">
            No hay externos en este canal. Invita al cliente por correo desde los miembros del
            canal.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {externals.map((id) => {
              const on = clientIds.includes(id);
              const name = users[id]?.displayName ?? id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => void toggle(id)}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    on
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-line text-ink-secondary hover:text-ink"
                  }`}
                >
                  <Avatar name={name} size="sm" />
                  {name}
                  {on && <span aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {people.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-ink">Cobro por hora al cliente</p>
          <ul className="mt-1 divide-y divide-line">
            {people.map((p) => (
              <li key={p.userId} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{nameOf(p)}</span>
                <RateField
                  rate={billRates[p.userId]}
                  label="Cobro al cliente por hora en dólares"
                  onSave={(r) => onBillRate(p.userId, r)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The header button (desktop) that opens a channel's hours. */
export function HoursButton({
  channelId,
  className,
}: Readonly<{ channelId: string; className: string }>) {
  return (
    <button
      type="button"
      onClick={() => useTimeLog.getState().open(channelId)}
      className={className}
      title="Horas: registra tu trabajo del día"
      data-hours-button
    >
      <ClockIcon aria-hidden="true" />
      <span className="hidden lg:inline">Horas</span>
      <span className="sr-only lg:hidden">Horas</span>
    </button>
  );
}

/** Admins: someone's hourly rate in this channel, edited in place. */
function RateField({
  rate,
  onSave,
  label = "Tarifa por hora en dólares",
}: Readonly<{
  rate: number | undefined;
  onSave: (rate: number) => Promise<void>;
  label?: string;
}>) {
  const [value, setValue] = useState(rate ? String(rate) : "");
  const [busy, setBusy] = useState(false);
  // Follow the saved rate when it changes (someone else set it), never on mount:
  // a late effect would overwrite what was just typed.
  const [shownRate, setShownRate] = useState(rate);
  if (rate !== shownRate) {
    setShownRate(rate);
    setValue(rate ? String(rate) : "");
  }
  const parsed = value.trim() === "" ? 0 : Number(value.replace(",", "."));
  const valid = Number.isFinite(parsed) && parsed >= 0;
  const changed = valid && parsed !== (rate ?? 0);
  async function save() {
    if (!changed || busy) return;
    setBusy(true);
    await onSave(Math.round(parsed * 100) / 100).finally(() => setBusy(false));
  }
  return (
    <label className="flex shrink-0 items-center gap-1 text-xs text-ink-secondary">
      ${" "}
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
        placeholder="0"
        aria-label={label}
        aria-invalid={!valid}
        className="w-16 rounded-md border border-line bg-surface px-1.5 py-1 text-right text-base text-ink focus:border-primary focus:outline-none sm:text-sm"
      />{" "}
      /h
    </label>
  );
}

export function TimeLogModal({
  channel,
  onClose,
}: Readonly<{ channel: Channel; onClose: () => void }>) {
  const me = useChat((s) => s.me);
  const users = useChat((s) => s.users);
  const showToast = useChat((s) => s.showToast);
  const version = useTimeLog((s) => s.version[channel.channelId] ?? 0);
  const today = calendarDay(Date.now());
  const admin = managesTimeRates(me?.role);
  const guest = me?.role === "guest";

  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [billRates, setBillRates] = useState<Record<string, number>>({});
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [client, setClient] = useState(false);
  /** Admins: the team's log, or what the client sees (and its settings). */
  const [view, setView] = useState<"team" | "client">("team");
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("week");
  const [date, setDate] = useState(today);
  const [duration, setDuration] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await timeApi.list(channel.channelId);
      setEntries(res.entries);
      setRates(res.rates ?? {});
      setBillRates(res.billRates ?? {});
      setClientIds(res.clientIds ?? []);
      setClient(res.client === true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las horas.");
    }
  }, [channel.channelId]);
  // On open, and whenever the server says this channel's log changed (live).
  useEffect(() => void load(), [load, version]);

  const nameOf = useCallback(
    (e: Pick<TimeEntry, "userId" | "userName">) => users[e.userId]?.displayName ?? e.userName,
    [users],
  );
  const shown = useMemo(
    () => (entries ?? []).filter((e) => inRange(e.date, range, today)),
    [entries, range, today],
  );
  const totals = useMemo(() => timeTotals(shown, rates), [shown, rates]);
  const days = useMemo(() => byDay(shown), [shown]);
  /** Everyone who has logged hours here, for the billing rates. */
  const people = useMemo(() => timeTotals(entries ?? []).byUser, [entries]);

  const minutes = parseDuration(duration);
  const canLog = canLogTime(channel) && !client;
  const valid = minutes !== null && description.trim().length > 0 && !!date;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || minutes === null || saving) return;
    setSaving(true);
    try {
      await timeApi.log(channel.channelId, { date, minutes, description: description.trim() });
      setDuration("");
      setDescription("");
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar.", "error");
    }
    setSaving(false);
  }

  async function remove(entry: TimeEntry) {
    try {
      await timeApi.remove(entry);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo borrar.", "error");
    }
  }

  async function saveRate(userId: string, rate: number) {
    try {
      await timeApi.setRate(channel.channelId, userId, rate);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar la tarifa.", "error");
    }
  }

  async function saveBillRate(userId: string, rate: number) {
    try {
      await timeApi.setBillRate(channel.channelId, userId, rate);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar el cobro.", "error");
    }
  }

  async function saveClients(ids: string[]) {
    try {
      await timeApi.setClients(channel.channelId, ids);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar el cliente.", "error");
    }
  }

  const footer = <SecondaryButton onClick={onClose}>Cerrar</SecondaryButton>;
  if (client) {
    return (
      <Modal title={`Horas y cobro · #${channel.name}`} onClose={onClose} footer={footer}>
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        )}
        <ClientHours channel={channel} entries={entries} billRates={billRates} nameOf={nameOf} />
      </Modal>
    );
  }

  return (
    <Modal title={`Horas · #${channel.name}`} onClose={onClose} footer={footer}>
      {admin && (
        <div
          role="tablist"
          aria-label="Vista"
          className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-surface-hover p-1"
        >
          {(
            [
              ["team", "Equipo"],
              ["client", "Cliente"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={`rounded-md px-2.5 py-1.5 text-sm font-semibold ${
                view === id ? "bg-surface text-ink shadow" : "text-ink-secondary hover:text-ink"
              }`}
            >
              {label}
              {id === "client" && clientIds.length > 0 && (
                <span className="ml-1.5 rounded-full bg-primary/20 px-1.5 text-xs text-primary">
                  {clientIds.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {admin && view === "client" ? (
        <div className="space-y-5">
          <ClientSettings
            channel={channel}
            people={people}
            billRates={billRates}
            clientIds={clientIds}
            nameOf={nameOf}
            onBillRate={saveBillRate}
            onClients={saveClients}
          />
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
              Así lo ve el cliente
            </p>
            <ClientHours
              channel={channel}
              entries={entries}
              billRates={billRates}
              nameOf={nameOf}
              preview
            />
          </div>
        </div>
      ) : (
        <div className="space-y-5" data-time-log>
          {canLog && (
            <form
              onSubmit={(e) => void submit(e)}
              className="space-y-2"
              aria-label="Registrar horas"
            >
              <p className="text-sm font-semibold text-ink">Registra tu trabajo del día</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={date}
                  max={today}
                  onChange={(e) => setDate(e.target.value)}
                  aria-label="Día"
                  className="input w-40 shrink-0"
                />
                <input
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="Horas: 2, 2:30, 45m"
                  aria-label="Tiempo trabajado"
                  aria-invalid={duration.trim() !== "" && minutes === null}
                  className="input min-w-0 flex-1"
                />
              </div>
              <div className="flex gap-2">
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={MAX_ENTRY_DESCRIPTION}
                  placeholder="¿Qué hiciste? (tarea, avance, bloqueo)"
                  aria-label="Qué hiciste"
                  className="input min-w-0 flex-1"
                />
                <button type="submit" className="btn-primary shrink-0" disabled={!valid || saving}>
                  {saving
                    ? "Guardando…"
                    : minutes
                      ? `Registrar ${formatMinutes(minutes)}`
                      : "Registrar"}
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <PeriodTabs ranges={RANGES} range={range} onChange={setRange} />
              <p className="text-sm text-ink" data-time-total>
                <strong className="font-semibold">{formatMinutes(totals.minutes)}</strong>
                {admin && (
                  <span className="text-ink-secondary">
                    {" "}
                    · <strong className="font-semibold text-primary">{money(totals.cost)}</strong>
                  </span>
                )}
              </p>
            </div>

            {/* By person: the team sees everyone's hours; admins also rates and cost. */}
            {!guest && totals.byUser.length > 0 && (
              <ul
                className="divide-y divide-line rounded-xl border border-line"
                aria-label="Por persona"
              >
                {totals.byUser.map((p) => (
                  <li key={p.userId} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={nameOf(p)} size="sm" />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-ink">
                      <span className="truncate">{nameOf(p)}</span>
                      {users[p.userId]?.role === "guest" && <GuestBadge />}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-ink">
                      {formatMinutes(p.minutes)}
                    </span>
                    {admin && (
                      <>
                        <RateField rate={rates[p.userId]} onSave={(r) => saveRate(p.userId, r)} />
                        <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums text-primary">
                          {p.rate ? money(p.cost) : "—"}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {admin && totals.unpricedMinutes > 0 && (
              <p className="text-xs text-warning" role="note">
                {formatMinutes(totals.unpricedMinutes)} sin tarifa: ponle una tarifa por hora a esa
                persona para ver su costo.
              </p>
            )}
            {admin && (
              <p className="text-xs text-ink-secondary">
                Las tarifas y los costos solo los ven los admins. Un externo solo ve sus propias
                horas; el cliente, lo que se le cobra (pestaña Cliente).
              </p>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
            >
              {error}
            </p>
          )}
          {entries === null && !error && (
            <p className="text-sm text-ink-secondary" aria-busy="true">
              Cargando…
            </p>
          )}
          {entries !== null && days.length === 0 && (
            <p className="text-sm text-ink-secondary">
              Aún no hay horas en este periodo. Registra arriba lo que hiciste hoy.
            </p>
          )}
          {days.map(([day, list]) => (
            <section key={day} aria-label={dayLabel(day, today)}>
              <h3 className="mb-1 flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                <span>{dayLabel(day, today)}</span>
                <span className="tabular-nums">
                  {formatMinutes(list.reduce((n, e) => n + e.minutes, 0))}
                </span>
              </h3>
              <ul className="space-y-1">
                {list.map((e) => (
                  <li
                    key={e.entryId}
                    className="group flex items-start gap-3 rounded-lg bg-white/[0.04] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-ink">{e.description}</p>
                      <p className="text-xs text-ink-secondary">{nameOf(e)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-ink">
                        {formatMinutes(e.minutes)}
                      </p>
                      {admin && rates[e.userId] !== undefined && (
                        <p className="text-xs tabular-nums text-primary">
                          {money(costOf(e.minutes, rates[e.userId] ?? 0))}
                        </p>
                      )}
                    </div>
                    {me && canLog && canDeleteTimeEntry(e, me.userId, me.role) && (
                      <button
                        type="button"
                        onClick={() => void remove(e)}
                        className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-error/15 hover:text-error"
                        aria-label={`Borrar: ${e.description}`}
                        title="Borrar"
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
