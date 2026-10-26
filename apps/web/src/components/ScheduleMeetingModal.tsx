import {
  dateInZone,
  dmMembers,
  MAX_EVENT_PARTICIPANTS,
  MAX_EVENT_DESCRIPTION_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  type CalendarEvent,
  type Message,
  type Recurrence,
} from "@mindfultech/shared";
import { useMemo, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { ulid } from "ulid";
import { calendarApi } from "../lib/calendarApi";
import { addMinutes, joinLocal, splitLocal } from "../lib/calendarUi";
import { useChat, useNameOf } from "../store";
import { useCalendar } from "../store/calendar";
import { Avatar } from "./Avatar";
import { ErrorNote } from "./CalendarModals";
import { CalendarIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { RepeatFields } from "./RepeatFields";
import { UserPicker } from "./UserPicker";

/** The next round half hour from now, as the form's default start. */
function nextSlot(now = Date.now()): { date: string; time: string } {
  const rounded = Math.ceil(now / 1_800_000) * 1_800_000;
  return splitLocal(rounded);
}

/**
 * "Schedule meeting" from a direct message: title, date, time and details.
 * The participants are the two people of the conversation, shown but not
 * editable; the server infers them from the channel. One request creates
 * the calendar event and posts the card in the chat together. It may repeat
 * (Phase 34): one card for the whole series, showing its next meeting.
 *
 * From a channel (Phase 36): the card goes in the channel (Join on it opens
 * the channel's call); invitees, preselected to the members of a private
 * channel, get it in their calendars.
 */
export function ScheduleMeetingModal({
  channelId,
  onClose,
}: Readonly<{ channelId: string; onClose: () => void }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const nameOf = useNameOf();
  const dm = dmMembers(channelId);
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  const users = useChat(useShallow((s) => Object.values(s.users)));
  const invitable = useMemo(
    () =>
      users
        .filter((u) => u.userId !== me?.userId && u.role !== "guest")
        .filter((u) => !channel?.members || channel.members.includes(u.userId))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users, me?.userId, channel?.members],
  );
  const [invited, setInvited] = useState<string[]>(() =>
    dm || !channel?.members
      ? []
      : channel.members.filter((id) => id !== me?.userId).slice(0, MAX_EVENT_PARTICIPANTS),
  );
  const members = dm ?? [me?.userId ?? "", ...invited];
  const peers = dm ? dm.filter((id) => id !== me?.userId) : invited;

  const slot = nextSlot();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(slot.date);
  const [startTime, setStartTime] = useState(slot.time);
  const [endTime, setEndTime] = useState(addMinutes(slot.time, 30));
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = dateInZone(Date.now());
  const firstStart = joinLocal(date, startTime);
  const firstDate = firstStart === null ? date : dateInZone(firstStart);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    const startAt = joinLocal(date, startTime);
    const endAt = joinLocal(date, endTime);
    if (startAt === null || endAt === null) return setError("Pick a date and times.");
    if (endAt <= startAt) return setError("The meeting must end after it starts.");
    setBusy(true);
    setError(null);
    const clientId = ulid();
    try {
      const { event, message } = (await calendarApi.createEvent({
        type: "meeting",
        title,
        description,
        allDay: false,
        startAt,
        endAt,
        channelId,
        clientId,
        ...(!dm && { participants: invited }),
        ...(recurrence && { recurrence }),
      })) as { event: CalendarEvent; message?: Message };
      // The server's own pushes bring both too; applying the reply makes the
      // card and the calendar entry show even if a push is lost.
      useCalendar
        .getState()
        .applyEvent({ type: "calendar.event_created", event, by: me.userId }, me);
      if (message) useChat.getState().receiveMessage(message, clientId);
      showToast(
        dm
          ? `${recurrence ? "Repeating meeting" : "Meeting"} scheduled with ${
              peers.map((id) => nameOf(id)).join(", ") || "yourself"
            }.`
          : `${recurrence ? "Repeating meeting" : "Meeting"} posted in #${channel?.name ?? "the channel"}.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't schedule the meeting.");
      setBusy(false);
    }
  }

  const canSubmit = !busy && !!title.trim() && !!date && !!startTime && !!endTime;

  return (
    <Modal
      title="Schedule meeting"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="schedule-meeting"
            className="btn-primary"
            disabled={!canSubmit}
          >
            {busy ? "Scheduling…" : "Schedule"}
          </button>
        </>
      }
    >
      <form id="schedule-meeting" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {!dm && (
          <p className="flex items-center gap-2 rounded-lg bg-surface-sidebar px-3 py-2 text-sm text-ink">
            <CalendarIcon className="shrink-0 text-ink-secondary" />
            <span>
              Posted in <strong>#{channel?.name ?? "this channel"}</strong>: everyone in it sees the
              card and can join the call.
            </span>
          </p>
        )}
        <div
          className={`flex items-center gap-2 rounded-lg bg-surface-sidebar px-3 py-2 text-sm text-ink ${
            dm ? "" : "hidden"
          }`}
        >
          <CalendarIcon className="shrink-0 text-ink-secondary" />
          <span className="text-ink-secondary">With</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {members.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full bg-surface-raised py-0.5 pl-0.5 pr-2 font-medium"
              >
                <Avatar name={nameOf(id)} size="xs" mine={id === me?.userId} />
                {id === me?.userId ? "You" : nameOf(id)}
              </span>
            ))}
          </span>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="meeting-title" className="block text-sm font-medium text-ink">
            Title
          </label>
          <input
            id="meeting-title"
            className="input"
            value={title}
            maxLength={MAX_EVENT_TITLE_LENGTH}
            placeholder="e.g. Project sync"
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <label htmlFor="meeting-date" className="block text-sm font-medium text-ink">
              Date
            </label>
            <input
              id="meeting-date"
              type="date"
              className="input"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="meeting-start" className="block text-sm font-medium text-ink">
              From
            </label>
            <input
              id="meeting-start"
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
          </div>
          <div className="space-y-1.5">
            <label htmlFor="meeting-end" className="block text-sm font-medium text-ink">
              To
            </label>
            <input
              id="meeting-end"
              type="time"
              className="input"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              disabled={busy}
              required
            />
          </div>
        </div>

        {!dm && (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-ink">
              In their calendars {invited.length > 0 && `(${invited.length})`}
            </span>
            <UserPicker users={invitable} selected={invited} onChange={setInvited} />
          </div>
        )}

        <RepeatFields
          first={firstDate}
          value={recurrence}
          onChange={setRecurrence}
          disabled={busy}
        />

        <div className="space-y-1.5">
          <label htmlFor="meeting-description" className="block text-sm font-medium text-ink">
            Details (optional)
          </label>
          <textarea
            id="meeting-description"
            className="input min-h-[4rem]"
            value={description}
            maxLength={MAX_EVENT_DESCRIPTION_LENGTH}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Modal>
  );
}
