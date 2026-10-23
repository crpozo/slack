import {
  addDays,
  countVacationDays,
  dateInZone,
  describeRecurrence,
  MAX_EVENT_DAYS,
  MAX_EVENT_DESCRIPTION_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_VACATION_NOTE_LENGTH,
  meetingStartDate,
  remainingDays,
  vacationOwner,
  yearOf,
  type CalendarEvent,
  type CalendarEventType,
  type CreateEventInput,
  type Recurrence,
  type UpdateEventInput,
  type VacationEvent,
} from "@mindfultech/shared";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  addMinutes,
  formatWhen,
  holidayDates,
  joinLocal,
  splitLocal,
  VACATION_STATUS_LABEL,
} from "../lib/calendarUi";
import { useChat, useNameOf } from "../store";
import { useCalendar } from "../store/calendar";
import { Avatar } from "./Avatar";
import { CalendarIcon, PencilIcon, RepeatIcon, TrashIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { RepeatFields } from "./RepeatFields";
import { UserPicker } from "./UserPicker";

const TYPE_LABEL: Record<CalendarEventType, string> = {
  meeting: "Meeting",
  vacation: "Vacation",
  holiday: "National holiday",
};

export function ErrorNote({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
    >
      {children}
    </p>
  );
}

function Field({
  id,
  label,
  children,
  hint,
}: Readonly<{ id: string; label: string; children: ReactNode; hint?: string }>) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-secondary">{hint}</p>}
    </div>
  );
}

/** Where a new event starts from: the clicked/selected cells, or defaults. */
export interface EventDraft {
  type?: CalendarEventType;
  startDate: string;
  endDate: string;
  allDay: boolean;
  /** Local times for a timed selection. */
  startAt?: number;
  endAt?: number;
}

/**
 * Creates an event (meeting, vacation request, or a holiday for admins), or
 * edits an existing meeting/holiday when `existing` is given.
 */
export function EventFormModal({
  draft,
  existing,
  onClose,
}: Readonly<{ draft: EventDraft; existing?: CalendarEvent; onClose: () => void }>) {
  const me = useChat((s) => s.me);
  const admin = me?.role === "admin";
  const users = useChat(useShallow((s) => Object.values(s.users)));
  const showToast = useChat((s) => s.showToast);
  const {
    createEvent,
    updateEvent,
    mine,
    year: balanceYear,
    events,
  } = useCalendar(
    useShallow((s) => ({
      createEvent: s.createEvent,
      updateEvent: s.updateEvent,
      mine: s.mine,
      year: s.year,
      events: s.events,
    })),
  );
  const editing = !!existing;
  const initialType: CalendarEventType = existing?.type ?? draft.type ?? "meeting";
  const [type, setType] = useState<CalendarEventType>(initialType);

  // Shared fields
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [startDate, setStartDate] = useState(existing?.startDate ?? draft.startDate);
  const [endDate, setEndDate] = useState(existing?.endDate ?? draft.endDate);
  // Meeting fields
  const timed = existing?.type === "meeting" && !existing.allDay ? existing : null;
  const initialStart = timed
    ? splitLocal(timed.startAt)
    : draft.startAt
      ? splitLocal(draft.startAt)
      : null;
  const initialEnd = timed ? splitLocal(timed.endAt) : draft.endAt ? splitLocal(draft.endAt) : null;
  const [allDay, setAllDay] = useState(
    existing?.type === "meeting" ? existing.allDay : draft.allDay,
  );
  const [date, setDate] = useState(initialStart?.date ?? draft.startDate);
  const [startTime, setStartTime] = useState(initialStart?.time ?? "09:00");
  const [endTime, setEndTime] = useState(initialEnd?.time ?? "09:30");
  const [participants, setParticipants] = useState<string[]>(
    existing?.type === "meeting" ? existing.participants.filter((id) => id !== me?.userId) : [],
  );
  // Phase 34: a series (editing one edits all of its meetings).
  const series = existing?.type === "meeting" && existing.recurrence ? existing : null;
  const [recurrence, setRecurrence] = useState<Recurrence | null>(series?.recurrence ?? null);
  // Vacation fields
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = dateInZone(Date.now());
  const invitable = useMemo(
    () =>
      users
        .filter((u) => u.userId !== me?.userId && u.role !== "guest")
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users, me?.userId],
  );
  const holidays = useMemo(() => holidayDates(Object.values(events)), [events]);
  const vacationDays =
    type === "vacation" && startDate && endDate && endDate >= startDate
      ? countVacationDays(startDate, endDate, holidays)
      : 0;
  const vacationYear = yearOf(startDate || today);
  const left = mine && balanceYear === vacationYear ? remainingDays(mine) : null;

  // The first meeting's date in the company timezone: what the series' rule counts from.
  const firstStart = allDay ? null : joinLocal(date, startTime);
  const firstDate = allDay ? startDate : firstStart !== null ? dateInZone(firstStart) : date;
  // Repeating all-day meetings last one day.
  const canRepeat = type === "meeting" && (!allDay || startDate === endDate);
  const rule = canRepeat ? recurrence : null;

  function buildInput(): CreateEventInput {
    if (type === "vacation") return { type, startDate, endDate, note };
    if (type === "holiday") return { type, title, description, startDate, endDate };
    const repeat = rule ? { recurrence: rule } : {};
    if (allDay) {
      return {
        type,
        title,
        description,
        allDay: true,
        startDate,
        endDate,
        participants,
        ...repeat,
      };
    }
    const startAt = joinLocal(date, startTime);
    const endAt = joinLocal(date, endTime);
    if (startAt === null || endAt === null) throw new Error("Pick a date and times");
    if (endAt <= startAt) throw new Error("The meeting must end after it starts");
    return { type, title, description, allDay: false, startAt, endAt, participants, ...repeat };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = buildInput();
      if (existing) {
        const patch: Record<string, unknown> = { ...input };
        delete patch.type;
        // No rule any more: the series becomes its first meeting alone.
        if (existing.type === "meeting" && !rule && existing.recurrence) patch.recurrence = null;
        await updateEvent(existing.eventId, patch as UpdateEventInput);
        showToast(series ? "Every meeting of the series was updated." : "Event updated.");
      } else {
        await createEvent(input);
        showToast(
          type === "vacation"
            ? `Vacation requested: ${vacationDays} working ${vacationDays === 1 ? "day" : "days"}. An admin will review it.`
            : type === "holiday"
              ? "Holiday added to everyone's calendar."
              : rule
                ? "Repeating meeting created."
                : "Meeting created.",
        );
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the event.");
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    (type === "vacation"
      ? !!startDate && !!endDate && vacationDays > 0 && (left === null || vacationDays <= left)
      : !!title.trim() && (type === "holiday" || allDay ? !!startDate && !!endDate : !!date));

  const types: CalendarEventType[] = admin
    ? ["meeting", "vacation", "holiday"]
    : ["meeting", "vacation"];
  const heading = editing
    ? series
      ? "Edit series"
      : `Edit ${TYPE_LABEL[initialType].toLowerCase()}`
    : type === "vacation"
      ? "Request vacation"
      : `New ${TYPE_LABEL[type].toLowerCase()}`;

  return (
    <Modal
      title={heading}
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="submit" form="event-form" className="btn-primary" disabled={!canSubmit}>
            {busy ? "Saving…" : editing ? "Save" : type === "vacation" ? "Request" : "Create"}
          </button>
        </>
      }
    >
      <form id="event-form" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {!editing && (
          <div
            role="radiogroup"
            aria-label="Event type"
            className="flex gap-1 rounded-lg bg-surface-sidebar p-1"
          >
            {types.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                onClick={() => setType(t)}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
                  type === t
                    ? "bg-surface-raised text-ink shadow"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}

        {type !== "vacation" && (
          <Field id="event-title" label="Title">
            <input
              id="event-title"
              className="input"
              value={title}
              maxLength={MAX_EVENT_TITLE_LENGTH}
              placeholder={type === "holiday" ? "e.g. Día de los Difuntos" : "e.g. Daily standup"}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              required
            />
          </Field>
        )}

        {type === "meeting" && (
          <>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                disabled={busy}
              />
              All day
            </label>
            {allDay ? (
              <DateRange
                startDate={startDate}
                endDate={endDate}
                onChange={(s, e) => {
                  setStartDate(s);
                  setEndDate(e);
                }}
                disabled={busy}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Field id="event-date" label="Date">
                    <input
                      id="event-date"
                      type="date"
                      className="input"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      disabled={busy}
                      required
                    />
                  </Field>
                </div>
                <Field id="event-start" label="From">
                  <input
                    id="event-start"
                    type="time"
                    className="input"
                    value={startTime}
                    onChange={(e) => {
                      setStartTime(e.target.value);
                      if (e.target.value >= endTime) setEndTime(addMinutes(e.target.value, 30));
                    }}
                    disabled={busy}
                    required
                  />
                </Field>
                <Field id="event-end" label="To">
                  <input
                    id="event-end"
                    type="time"
                    className="input"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    disabled={busy}
                    required
                  />
                </Field>
              </div>
            )}
            {series && (
              <p className="rounded-lg bg-surface-sidebar px-3 py-2 text-xs text-ink-secondary">
                Changes apply to every meeting of the series. The date is its first meeting.
              </p>
            )}
            {canRepeat ? (
              <RepeatFields
                first={firstDate}
                value={recurrence}
                onChange={setRecurrence}
                disabled={busy}
              />
            ) : (
              <p className="text-xs text-ink-secondary">
                Only one-day all-day meetings can repeat.
              </p>
            )}
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-ink">
                Invite {participants.length > 0 && `(${participants.length})`}
              </span>
              {invitable.length === 0 ? (
                <p className="text-sm text-ink-secondary">
                  Your team appears here once they sign in.
                </p>
              ) : (
                <UserPicker users={invitable} selected={participants} onChange={setParticipants} />
              )}
            </div>
          </>
        )}

        {type === "holiday" && (
          <DateRange
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
            }}
            disabled={busy}
          />
        )}

        {type === "vacation" && (
          <>
            <DateRange
              startDate={startDate}
              endDate={endDate}
              min={today}
              onChange={(s, e) => {
                setStartDate(s);
                setEndDate(e);
              }}
              disabled={busy}
            />
            <p className="rounded-lg bg-surface-sidebar px-3 py-2 text-sm text-ink">
              <strong>{vacationDays}</strong> working {vacationDays === 1 ? "day" : "days"}{" "}
              <span className="text-ink-secondary">(weekends and holidays don't count)</span>
              {left !== null && (
                <>
                  {" · "}
                  <span className={vacationDays > left ? "font-medium text-error" : ""}>
                    {left} left in {vacationYear}
                  </span>
                </>
              )}
            </p>
            <Field id="event-note" label="Note for the admins (optional)">
              <textarea
                id="event-note"
                className="input min-h-[4rem]"
                value={note}
                maxLength={MAX_VACATION_NOTE_LENGTH}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
              />
            </Field>
          </>
        )}

        {type !== "vacation" && (
          <Field id="event-description" label="Details (optional)">
            <textarea
              id="event-description"
              className="input min-h-[4rem]"
              value={description}
              maxLength={MAX_EVENT_DESCRIPTION_LENGTH}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </Field>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Modal>
  );
}

/** Start and end date inputs (inclusive); the end follows the start when it falls behind. */
function DateRange({
  startDate,
  endDate,
  min,
  onChange,
  disabled,
}: Readonly<{
  startDate: string;
  endDate: string;
  min?: string;
  onChange: (startDate: string, endDate: string) => void;
  disabled: boolean;
}>) {
  const max = startDate ? addDays(startDate, MAX_EVENT_DAYS - 1) : undefined;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field id="event-start-date" label="From">
        <input
          id="event-start-date"
          type="date"
          className="input"
          value={startDate}
          min={min}
          onChange={(e) => {
            const s = e.target.value;
            onChange(s, !endDate || endDate < s ? s : endDate);
          }}
          disabled={disabled}
          required
        />
      </Field>
      <Field id="event-end-date" label="To">
        <input
          id="event-end-date"
          type="date"
          className="input"
          value={endDate}
          min={startDate || min}
          max={max}
          onChange={(e) => onChange(startDate, e.target.value)}
          disabled={disabled}
          required
        />
      </Field>
    </div>
  );
}

function StatusChip({ status }: Readonly<{ status: VacationEvent["status"] }>) {
  const color =
    status === "approved"
      ? "bg-success/25 text-ink"
      : status === "pending"
        ? "bg-warning/30 text-ink"
        : "bg-error/20 text-ink";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
      {VACATION_STATUS_LABEL[status]}
    </span>
  );
}

export { StatusChip };

/** An event's details with what the viewer may do about it. */
export function EventDetailsModal({
  event,
  onClose,
  onEdit,
}: Readonly<{
  event: CalendarEvent;
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
}>) {
  const me = useChat((s) => s.me);
  const nameOf = useNameOf();
  const showToast = useChat((s) => s.showToast);
  const { deleteEvent, cancelOccurrence, decideVacation, stored } = useCalendar(
    useShallow((s) => ({
      deleteEvent: s.deleteEvent,
      cancelOccurrence: s.cancelOccurrence,
      decideVacation: s.decideVacation,
      stored: s.events[event.eventId],
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  /** Which deletion awaits a "Sure?": the whole event (series), or this one meeting of it. */
  const [confirming, setConfirming] = useState<"event" | "occurrence" | null>(null);

  if (!me) return null;
  const admin = me.role === "admin";
  const organizer = event.createdBy === me.userId;
  const requester = event.type === "vacation" && vacationOwner(event) === me.userId;

  const canEdit = (event.type === "meeting" && organizer) || (event.type === "holiday" && admin);
  const canDelete =
    event.type === "meeting"
      ? organizer || admin
      : event.type === "holiday"
        ? admin
        : admin || (requester && event.status === "pending");
  // Phase 34: one meeting of a series (`event`) and the series it belongs to.
  const series = event.type === "meeting" && event.recurrence ? event : null;
  const seriesRow = series && stored?.type === "meeting" ? stored : series;
  const occurrence = series?.occurrence;
  const deleteLabel =
    event.type === "vacation" ? "Cancel request" : series ? "Delete series" : "Delete";

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      showToast(done);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <Modal
      title={TYPE_LABEL[event.type]}
      onClose={onClose}
      footer={
        <>
          {canDelete && !confirming && (
            <span className="mr-auto flex flex-wrap items-center gap-1">
              {occurrence && (
                <button
                  type="button"
                  onClick={() => setConfirming("occurrence")}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-error hover:bg-error/10 disabled:opacity-50"
                >
                  <TrashIcon /> Cancel this meeting
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirming("event")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-error hover:bg-error/10 disabled:opacity-50"
              >
                {!occurrence && <TrashIcon />} {deleteLabel}
              </button>
            </span>
          )}
          {confirming && (
            <span className="mr-auto flex items-center gap-2 text-sm">
              <span className="text-ink-secondary">
                {confirming === "occurrence"
                  ? "Cancel only this one?"
                  : series
                    ? "Delete every meeting?"
                    : "Sure?"}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void (confirming === "occurrence" && occurrence
                    ? run(
                        () => cancelOccurrence(event.eventId, occurrence),
                        "That meeting was cancelled; the rest of the series stays.",
                      )
                    : run(
                        () => deleteEvent(event.eventId),
                        event.type === "vacation"
                          ? "Request cancelled; the days are back."
                          : series
                            ? "Series deleted."
                            : "Deleted.",
                      ))
                }
                className="rounded-lg bg-error px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-50"
              >
                {busy
                  ? "…"
                  : confirming === "occurrence"
                    ? "Yes, cancel it"
                    : `Yes, ${deleteLabel.toLowerCase()}`}
              </button>
              <SecondaryButton onClick={() => setConfirming(null)} disabled={busy}>
                No
              </SecondaryButton>
            </span>
          )}
          {canEdit && (
            <SecondaryButton onClick={() => onEdit(seriesRow ?? event)} disabled={busy}>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <PencilIcon /> {series ? "Edit series" : "Edit"}
              </span>
            </SecondaryButton>
          )}
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-ink">
            {event.type === "vacation" ? `${nameOf(vacationOwner(event))} · Vacation` : event.title}
          </h3>
          <p className="mt-1 flex items-center gap-2 text-sm text-ink-secondary">
            <CalendarIcon /> {formatWhen(event)}
          </p>
          {seriesRow?.recurrence && (
            <p className="mt-1 flex items-center gap-2 text-sm text-ink-secondary">
              <RepeatIcon aria-hidden="true" />
              <span>
                {describeRecurrence(seriesRow.recurrence, meetingStartDate(seriesRow))}
                {seriesRow.exceptions?.length ? ` · ${seriesRow.exceptions.length} cancelled` : ""}
              </span>
            </p>
          )}
        </div>

        {event.type === "vacation" && (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={event.status} />
              <span className="text-ink-secondary">
                {event.days} working {event.days === 1 ? "day" : "days"} of{" "}
                {yearOf(event.startDate)}
              </span>
            </div>
            {event.note && (
              <p className="text-ink">
                <span className="text-ink-secondary">Note:</span> {event.note}
              </p>
            )}
            {event.decidedBy && (
              <p className="text-ink-secondary">
                {VACATION_STATUS_LABEL[event.status]} by {nameOf(event.decidedBy)}
                {event.decisionNote && `: “${event.decisionNote}”`}
              </p>
            )}
          </div>
        )}

        {event.type !== "vacation" && event.description && (
          <p className="whitespace-pre-wrap text-sm text-ink">{event.description}</p>
        )}

        {event.type === "meeting" && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink">Participants</p>
            <ul className="flex flex-wrap gap-2">
              {event.participants.map((id) => (
                <li
                  key={id}
                  className="flex items-center gap-1.5 rounded-full bg-surface-sidebar py-1 pl-1 pr-3 text-sm text-ink"
                >
                  <Avatar name={nameOf(id)} size="sm" mine={id === me.userId} />
                  {nameOf(id)}
                  {id === event.createdBy && (
                    <span className="text-xs text-ink-secondary">organizer</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {event.type === "vacation" && event.status === "pending" && admin && (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <p className="text-sm font-medium text-ink">Decision</p>
            <input
              className="input"
              placeholder="Note for the requester (optional)"
              value={decisionNote}
              maxLength={MAX_VACATION_NOTE_LENGTH}
              onChange={(e) => setDecisionNote(e.target.value)}
              disabled={busy}
              aria-label="Decision note"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => decideVacation(event.eventId, { status: "approved", note: decisionNote }),
                    "Vacation approved.",
                  )
                }
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => decideVacation(event.eventId, { status: "rejected", note: decisionNote }),
                    "Vacation rejected.",
                  )
                }
                className="flex-1 rounded-lg border border-error/50 px-4 py-2 text-sm font-semibold text-error hover:bg-error/10 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
