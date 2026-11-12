import {
  calendarDay,
  canDeleteTimeEntry,
  canLogTime,
  costOf,
  formatMinutes,
  managesTimeRates,
  MAX_ENTRY_DESCRIPTION,
  parseDuration,
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

type Range = "week" | "month" | "all";
const RANGES: Array<{ id: Range; label: string }> = [
  { id: "week", label: "Esta semana" },
  { id: "month", label: "Este mes" },
  { id: "all", label: "Todo" },
];

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
}: Readonly<{ rate: number | undefined; onSave: (rate: number) => Promise<void> }>) {
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
      $
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
        aria-label="Tarifa por hora en dólares"
        aria-invalid={!valid}
        className="w-16 rounded-md border border-line bg-surface px-1.5 py-1 text-right text-base text-ink focus:border-primary focus:outline-none sm:text-sm"
      />
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
  const shown = useMemo(() => {
    const all = entries ?? [];
    if (range === "all") return all;
    const from = range === "week" ? weekStart(today) : `${today.slice(0, 7)}-01`;
    return all.filter((e) => e.date >= from);
  }, [entries, range, today]);
  const totals = useMemo(() => timeTotals(shown, rates), [shown, rates]);
  const days = useMemo(() => {
    const byDay = new Map<string, TimeEntry[]>();
    for (const e of shown) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
    return [...byDay.entries()];
  }, [shown]);

  const minutes = parseDuration(duration);
  const canLog = canLogTime(channel);
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

  return (
    <Modal
      title={`Horas · #${channel.name}`}
      onClose={onClose}
      footer={<SecondaryButton onClick={onClose}>Cerrar</SecondaryButton>}
    >
      <div className="space-y-5" data-time-log>
        {canLog && (
          <form onSubmit={(e) => void submit(e)} className="space-y-2" aria-label="Registrar horas">
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
            <div
              role="tablist"
              aria-label="Periodo"
              className="flex gap-1 rounded-lg bg-surface-hover p-1"
            >
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                    range === r.id
                      ? "bg-surface text-ink shadow"
                      : "text-ink-secondary hover:text-ink"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
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
              horas.
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
    </Modal>
  );
}
