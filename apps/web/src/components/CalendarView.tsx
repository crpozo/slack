import type { DateSelectArg, DatesSetArg, EventClickArg } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import {
  addDays,
  dateInZone,
  eventIdOfKey,
  MAX_VACATION_ALLOWANCE,
  nextOccurrence,
  occurrenceAt,
  occurrenceKey,
  remainingDays,
  vacationOwner,
  type CalendarEvent,
  type VacationBalance,
  type VacationEvent,
} from "@mindfultech/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { eventStartDate, monthOf, monthTitle } from "../lib/agenda";
import { formatDateRange, holidayDates, toCalendarInput } from "../lib/calendarUi";
import { MOBILE_QUERY, useMediaQuery } from "../lib/hooks";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useChat, useNameOf } from "../store";
import {
  drawableEvents,
  loadedSpan,
  localDate,
  thisYear,
  useCalendar,
  visibleRange,
} from "../store/calendar";
import { Avatar } from "./Avatar";
import { EventDetailsModal, EventFormModal, StatusChip, type EventDraft } from "./CalendarModals";
import {
  CalendarIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  MenuIcon,
  PlusIcon,
} from "./icons";
import { MobileAgenda } from "./MobileAgenda";
import { Modal } from "./Modal";
import { UnreadAlertsDot } from "./NotificationBell";

type ViewName = "dayGridMonth" | "timeGridWeek" | "timeGridDay";
const VIEWS: Array<{ name: ViewName; label: string }> = [
  { name: "dayGridMonth", label: "Month" },
  { name: "timeGridWeek", label: "Week" },
  { name: "timeGridDay", label: "Day" },
];
const VIEW_KEY = "slack.calendar.view";

function savedView(): ViewName {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.some((x) => x.name === v) ? (v as ViewName) : "dayGridMonth";
  } catch {
    return "dayGridMonth";
  }
}

const iconButton =
  "rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50";

/** The whole year, in chunks the API accepts, so the requests list isn't just the month on screen. */
function yearChunks(year: string): Array<[string, string]> {
  return [
    [`${year}-01-01`, `${year}-03-31`],
    [`${year}-04-01`, `${year}-06-30`],
    [`${year}-07-01`, `${year}-09-30`],
    [`${year}-10-01`, `${year}-12-31`],
  ];
}

/** Replaces the chat column: the company calendar, with the vacations panel beside it. */
export function CalendarView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const nameOf = useNameOf();
  const { events, loadedRanges, loading, error, loadRange, loadBalances, clearError } = useCalendar(
    useShallow((s) => ({
      events: s.events,
      loadedRanges: s.loadedRanges,
      loading: s.loading,
      error: s.error,
      loadRange: s.loadRange,
      loadBalances: s.loadBalances,
      clearError: s.clearError,
    })),
  );
  const calendarRef = useRef<FullCalendar>(null);
  const [title, setTitle] = useState("");
  const [view, setView] = useState<ViewName>(savedView);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  /** The `occurrenceKey` of the open event (a series' meeting: `<eventId>@<date>`). */
  const [selected, setSelected] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const configured = tasksApiConfigured();
  // Phones get the continuous day list instead of the grid (see MobileAgenda).
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [agendaMonth, setAgendaMonth] = useState(() => monthOf(dateInZone(Date.now())));
  const [todayNonce, setTodayNonce] = useState(0);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  // `?event=<id>` (a meeting card's button): go to its day and open it, then drop the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const wanted = searchParams.get("event");
  useEffect(() => {
    if (!wanted || loading) return;
    const stored = events[wanted];
    // A series opens on its meeting happening now or next (its first, once it's over).
    const event =
      stored?.type === "meeting" && stored.recurrence
        ? (nextOccurrence(stored, Date.now()) ?? stored)
        : stored;
    if (event) {
      calendarRef.current?.getApi().gotoDate(new Date(event.startAt));
      setFocusDate(eventStartDate(event));
      setSelected(occurrenceKey(event));
    } else if (Object.keys(events).length > 0) {
      showToast("That meeting is no longer on the calendar.");
    } else {
      return; // nothing loaded yet: try again once the year arrives
    }
    setSearchParams({}, { replace: true });
  }, [wanted, loading, events, showToast, setSearchParams]);

  useEffect(() => {
    if (!configured) return;
    void loadBalances();
    for (const [from, to] of yearChunks(thisYear())) void loadRange(from, to);
  }, [configured, loadBalances, loadRange]);

  useEffect(() => {
    if (!error) return;
    showToast(error);
    clearError();
  }, [error, showToast, clearError]);

  // Series are drawn as their meetings over everything loaded so far.
  const span = useMemo(() => loadedSpan(loadedRanges), [loadedRanges]);
  const agendaEvents = useMemo(() => drawableEvents(events, span), [events, span]);
  const inputs = useMemo(
    () => agendaEvents.map((e) => toCalendarInput(e, nameOf)),
    [agendaEvents, nameOf],
  );
  const holidays = useMemo(() => holidayDates(Object.values(events)), [events]);

  const onDatesSet = useCallback(
    (arg: DatesSetArg) => {
      setTitle(arg.view.title);
      const { from, to } = visibleRange(arg);
      void loadRange(from, to);
    },
    [loadRange],
  );

  const onSelect = useCallback((arg: DateSelectArg) => {
    const startDate = localDate(arg.start);
    const endDate = arg.allDay ? addDays(localDate(arg.end), -1) : localDate(arg.end);
    setDraft({
      startDate,
      endDate: endDate < startDate ? startDate : endDate,
      allDay: arg.allDay,
      ...(!arg.allDay && { startAt: arg.start.getTime(), endAt: arg.end.getTime() }),
    });
    arg.view.calendar.unselect();
  }, []);

  const onEventClick = useCallback((arg: EventClickArg) => {
    arg.jsEvent.preventDefault();
    setSelected(arg.event.id);
  }, []);

  const api = () => calendarRef.current?.getApi();
  const changeView = (name: ViewName) => {
    setView(name);
    try {
      localStorage.setItem(VIEW_KEY, name);
    } catch {
      // Not remembered; fine.
    }
    api()?.changeView(name);
  };

  const today = dateInZone(Date.now());
  const newEvent = (type?: EventDraft["type"]) =>
    setDraft({
      type,
      startDate: today,
      endDate: today,
      allDay: type !== undefined && type !== "meeting",
    });

  if (!me) return null;
  const selectedEvent = selected ? eventOfKey(events, selected) : undefined;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        {onOpenSidebar && (
          <button
            type="button"
            onClick={onOpenSidebar}
            className="relative rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
            aria-label="Open menu"
          >
            <MenuIcon />
            <UnreadAlertsDot />
          </button>
        )}
        {mobile ? (
          <>
            {/* Like iOS: the month and year on the left (tap: back to today), "+" on the right. */}
            <button
              type="button"
              onClick={() => setTodayNonce((n) => n + 1)}
              className="min-w-0 truncate text-left text-xl font-bold text-ink"
              aria-label={`${monthTitle(agendaMonth)}. Back to today`}
              aria-live="polite"
            >
              {monthTitle(agendaMonth)}
            </button>
            <button
              type="button"
              className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary text-on-primary hover:bg-primary-hover"
              onClick={() => newEvent()}
              aria-label="New event"
            >
              <PlusIcon />
            </button>
          </>
        ) : (
          <>
            <CalendarIcon className="text-ink-secondary" />
            <h1 className="truncate font-semibold text-ink">Calendar</h1>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink lg:hidden"
              >
                Vacations
              </button>
              <button type="button" className="btn-primary" onClick={() => newEvent()}>
                <PlusIcon /> <span className="hidden sm:inline">New event</span>
              </button>
            </div>
          </>
        )}
      </header>

      {!configured ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-ink-secondary">
          This deployment has no calendar API URL.
        </div>
      ) : mobile ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <VacationSummaryRow onOpen={() => setPanelOpen(true)} />
          <MobileAgenda
            events={agendaEvents}
            holidays={holidays}
            nameOf={nameOf}
            onMonthChange={setAgendaMonth}
            onRangeChange={loadRange}
            onSelectEvent={setSelected}
            onNewEvent={(date) => setDraft({ startDate: date, endDate: date, allDay: false })}
            focusDate={focusDate}
            todayNonce={todayNonce}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col p-3 sm:p-4" aria-label="Calendar">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={iconButton}
                  onClick={() => api()?.prev()}
                  aria-label="Previous"
                >
                  <ChevronRightIcon className="rotate-180" />
                </button>
                <button
                  type="button"
                  onClick={() => api()?.today()}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-hover"
                >
                  Today
                </button>
                <button
                  type="button"
                  className={iconButton}
                  onClick={() => api()?.next()}
                  aria-label="Next"
                >
                  <ChevronRightIcon />
                </button>
              </div>
              <h2
                className="order-last basis-full truncate text-base font-semibold text-ink sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto sm:text-lg"
                aria-live="polite"
              >
                {title}
                {loading && (
                  <span className="ml-2 text-xs font-normal text-ink-secondary">Loading…</span>
                )}
              </h2>
              <div
                role="radiogroup"
                aria-label="View"
                className="flex gap-1 rounded-lg bg-surface-sidebar p-1"
              >
                {VIEWS.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    role="radio"
                    aria-checked={view === v.name}
                    onClick={() => changeView(v.name)}
                    className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      view === v.name
                        ? "bg-surface-raised text-ink shadow"
                        : "text-ink-secondary hover:text-ink"
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <FullCalendar
                ref={calendarRef}
                plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                initialView={view}
                headerToolbar={false}
                height="100%"
                firstDay={1}
                timeZone="local"
                nowIndicator
                selectable
                selectMirror
                unselectAuto
                dayMaxEvents={3}
                eventOrder="rank,start,title"
                events={inputs}
                datesSet={onDatesSet}
                select={onSelect}
                eventClick={onEventClick}
                dayCellClassNames={(arg) =>
                  holidays.has(localDate(arg.date)) ? ["fc-holiday"] : []
                }
                slotMinTime="06:00:00"
                slotMaxTime="22:00:00"
                scrollTime="08:00:00"
                eventTimeFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
                slotLabelFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
              />
            </div>
            <Legend />
          </section>
          <aside
            className="hidden w-80 shrink-0 overflow-y-auto border-l border-line p-4 lg:block"
            aria-label="Vacations"
          >
            <VacationsPanel onRequest={() => newEvent("vacation")} onOpen={setSelected} />
          </aside>
        </div>
      )}

      {panelOpen && (
        <Modal title="Vacations" onClose={() => setPanelOpen(false)}>
          <VacationsPanel
            onRequest={() => {
              setPanelOpen(false);
              newEvent("vacation");
            }}
            onOpen={(id) => {
              setPanelOpen(false);
              setSelected(id);
            }}
          />
        </Modal>
      )}
      {draft && <EventFormModal draft={draft} onClose={() => setDraft(null)} />}
      {editing && (
        <EventFormModal
          draft={{
            startDate: editing.startDate ?? today,
            endDate: editing.endDate ?? today,
            allDay: editing.type !== "meeting" || editing.allDay,
          }}
          existing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {selectedEvent && !editing && (
        <EventDetailsModal
          event={selectedEvent}
          onClose={() => setSelected(null)}
          onEdit={(e) => {
            setSelected(null);
            setEditing(e);
          }}
        />
      )}
    </div>
  );
}

/** The event an `occurrenceKey` names: a series' meeting on its date, or the event itself. */
function eventOfKey(events: Record<string, CalendarEvent>, key: string): CalendarEvent | undefined {
  const event = events[eventIdOfKey(key)];
  const date = key.split("@")[1];
  if (event?.type === "meeting" && event.recurrence && date) return occurrenceAt(event, date);
  return event;
}

/** Phones: the vacations panel lives behind one row above the day list. */
function VacationSummaryRow({ onOpen }: Readonly<{ onOpen: () => void }>) {
  const mine = useCalendar((s) => s.mine);
  const admin = useChat((s) => s.me?.role === "admin");
  const pending = useCalendar(
    (s) =>
      Object.values(s.events).filter((e) => e.type === "vacation" && e.status === "pending").length,
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-left text-sm hover:bg-surface-hover"
    >
      <span className="h-2.5 w-2.5 rounded-full bg-success" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-ink">
        {mine ? (
          <>
            <span className="font-semibold">{remainingDays(mine)}</span> of {mine.allowance}{" "}
            vacation days left
          </>
        ) : (
          "Vacations"
        )}
        {admin && pending > 0 && (
          <span className="ml-2 rounded-full bg-warning/30 px-2 py-0.5 text-xs font-semibold">
            {pending} to review
          </span>
        )}
      </span>
      <ChevronRightIcon className="shrink-0 text-ink-secondary" aria-hidden="true" />
    </button>
  );
}

function Legend() {
  const items = [
    { className: "bg-primary", label: "Meeting" },
    { className: "bg-success", label: "Vacation" },
    { className: "border border-dashed border-success bg-success/25", label: "Pending" },
    { className: "bg-error", label: "Holiday" },
  ];
  return (
    <ul
      className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary"
      aria-label="Legend"
    >
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-sm ${i.className}`}
            aria-hidden="true"
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// --- Vacations panel ----------------------------------------------------------------

function BalanceBar({ balance }: Readonly<{ balance: VacationBalance }>) {
  const pct = (n: number) =>
    `${balance.allowance ? Math.min(100, (n / balance.allowance) * 100) : 0}%`;
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-surface-hover"
      role="img"
      aria-label={`${balance.used} used, ${balance.pending} pending, ${remainingDays(balance)} left of ${balance.allowance}`}
    >
      <span className="bg-success" style={{ width: pct(balance.used) }} />
      <span className="bg-warning" style={{ width: pct(balance.pending) }} />
    </div>
  );
}

function VacationsPanel({
  onRequest,
  onOpen,
}: Readonly<{ onRequest: () => void; onOpen: (eventId: string) => void }>) {
  const me = useChat((s) => s.me);
  const users = useChat((s) => s.users);
  const nameOf = useNameOf();
  const { events, year, mine, balances, loadBalances, loadRange, setAllowance } = useCalendar(
    useShallow((s) => ({
      events: s.events,
      year: s.year,
      mine: s.mine,
      balances: s.balances,
      loadBalances: s.loadBalances,
      loadRange: s.loadRange,
      setAllowance: s.setAllowance,
    })),
  );
  const admin = me?.role === "admin";

  const changeYear = (delta: number) => {
    const next = String(Number(year) + delta);
    void loadBalances(next);
    for (const [from, to] of yearChunks(next)) void loadRange(from, to);
  };

  const vacations = useMemo(
    () =>
      Object.values(events)
        .filter((e): e is VacationEvent => e.type === "vacation" && e.startDate.startsWith(year))
        .sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [events, year],
  );
  const myRequests = vacations.filter((v) => vacationOwner(v) === me?.userId);
  const pendingQueue = vacations
    .filter((v) => v.status === "pending" && vacationOwner(v) !== me?.userId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  // Everyone in the directory (members only), with their ledger row or the default.
  const team = useMemo(() => {
    if (!admin) return [];
    const byUser = new Map(balances.map((b) => [b.userId, b]));
    return Object.values(users)
      .filter((u) => u.role !== "guest")
      .map((u) => ({
        userId: u.userId,
        name: u.displayName,
        balance: byUser.get(u.userId) ?? {
          userId: u.userId,
          year,
          allowance: 15,
          used: 0,
          pending: 0,
        },
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [admin, balances, users, year]);

  if (!me) return null;

  return (
    <div className="space-y-5">
      <section aria-labelledby="balance-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="balance-heading" className="font-semibold text-ink">
            My vacation
          </h2>
          <div className="flex items-center gap-0.5 text-sm">
            <button
              type="button"
              className={iconButton}
              onClick={() => changeYear(-1)}
              aria-label="Previous year"
            >
              <ChevronRightIcon className="rotate-180" />
            </button>
            <span className="tabular-nums text-ink">{year}</span>
            <button
              type="button"
              className={iconButton}
              onClick={() => changeYear(1)}
              aria-label="Next year"
            >
              <ChevronRightIcon />
            </button>
          </div>
        </div>
        {mine ? (
          <div className="space-y-2 rounded-xl border border-line p-3">
            <p className="text-2xl font-semibold text-ink">
              {remainingDays(mine)}
              <span className="text-sm font-normal text-ink-secondary">
                {" "}
                of {mine.allowance} days left
              </span>
            </p>
            <BalanceBar balance={mine} />
            <p className="text-xs text-ink-secondary">
              {mine.used} used · {mine.pending} pending approval
            </p>
            <button type="button" className="btn-primary w-full" onClick={onRequest}>
              Request vacation
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink-secondary">Loading your balance…</p>
        )}
      </section>

      <section aria-labelledby="requests-heading">
        <h2 id="requests-heading" className="mb-2 font-semibold text-ink">
          My requests
        </h2>
        {myRequests.length === 0 ? (
          <p className="text-sm text-ink-secondary">No requests in {year}.</p>
        ) : (
          <ul className="space-y-1.5">
            {myRequests.map((v) => (
              <li key={v.eventId}>
                <button
                  type="button"
                  onClick={() => onOpen(v.eventId)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-surface-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-ink">
                      {formatDateRange(v.startDate, v.endDate)}
                    </span>
                    <span className="text-xs text-ink-secondary">
                      {v.days} {v.days === 1 ? "day" : "days"}
                    </span>
                  </span>
                  <StatusChip status={v.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {admin && (
        <section aria-labelledby="queue-heading">
          <h2 id="queue-heading" className="mb-2 font-semibold text-ink">
            Pending requests{pendingQueue.length > 0 && ` (${pendingQueue.length})`}
          </h2>
          {pendingQueue.length === 0 ? (
            <p className="text-sm text-ink-secondary">Nothing to review.</p>
          ) : (
            <ul className="space-y-1.5">
              {pendingQueue.map((v) => (
                <li key={v.eventId}>
                  <button
                    type="button"
                    onClick={() => onOpen(v.eventId)}
                    className="flex w-full items-center gap-2 rounded-lg border border-warning/60 bg-warning/10 px-3 py-2 text-left text-sm hover:bg-warning/20"
                  >
                    <Avatar name={nameOf(vacationOwner(v))} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">
                        {nameOf(vacationOwner(v))}
                      </span>
                      <span className="block truncate text-xs text-ink-secondary">
                        {formatDateRange(v.startDate, v.endDate)} · {v.days}{" "}
                        {v.days === 1 ? "day" : "days"}
                      </span>
                    </span>
                    <ChevronRightIcon className="shrink-0 text-ink-secondary" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {admin && team.length > 0 && <TeamBalances year={year} team={team} onSave={setAllowance} />}
    </div>
  );
}

function TeamBalances({
  year,
  team,
  onSave,
}: Readonly<{
  year: string;
  team: Array<{ userId: string; name: string; balance: VacationBalance }>;
  onSave: (userId: string, year: string, allowance: number) => Promise<void>;
}>) {
  const showToast = useChat((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent, userId: string) {
    e.preventDefault();
    const allowance = Number(value);
    if (!Number.isInteger(allowance) || allowance < 0 || allowance > MAX_VACATION_ALLOWANCE) return;
    setBusy(true);
    try {
      await onSave(userId, year, allowance);
      setEditingId(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't change the allowance.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="team-heading">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mb-2 flex w-full items-center justify-between font-semibold text-ink"
      >
        <span id="team-heading">Team balances {year}</span>
        <ChevronUpIcon
          className={`text-ink-secondary transition-transform ${open ? "" : "rotate-180"}`}
        />
      </button>
      {open && (
        <ul className="space-y-2">
          {team.map(({ userId, name, balance }) => (
            <li key={userId} className="rounded-lg border border-line px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-ink">{name}</span>
                {editingId === userId ? (
                  <form onSubmit={(e) => void save(e, userId)} className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={MAX_VACATION_ALLOWANCE}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      className="input w-16 py-1"
                      aria-label={`Allowance for ${name}`}
                      disabled={busy}
                    />
                    <button type="submit" className="btn-primary px-2 py-1" disabled={busy}>
                      Save
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                    >
                      <CloseIcon />
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(userId);
                      setValue(String(balance.allowance));
                    }}
                    className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
                    title="Change the yearly allowance"
                  >
                    {remainingDays(balance)} of {balance.allowance} left
                  </button>
                )}
              </div>
              <div className="mt-1.5">
                <BalanceBar balance={balance} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
