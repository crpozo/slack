import type { MeetingCard as MeetingCardData } from "@mindfultech/shared";
import { useNavigate } from "react-router-dom";
import { formatWhen } from "../lib/calendarUi";
import { useNameOf } from "../store";
import { Avatar } from "./Avatar";
import { CalendarIcon, ChevronRightIcon } from "./icons";

/** Where the calendar opens this card's event. */
export const calendarEventPath = (eventId: string) =>
  `/app/calendar?event=${encodeURIComponent(eventId)}`;

/**
 * A "meeting scheduled" message: a card instead of a text bubble, with the
 * title, when (in the viewer's local time), the details, the two people and
 * a button that opens the live event in the calendar. The card is a
 * snapshot from when the meeting was scheduled; the calendar is the truth.
 */
export function MeetingCard({
  card,
  mine,
  myUserId,
}: Readonly<{ card: MeetingCardData; mine: boolean; myUserId: string | undefined }>) {
  const navigate = useNavigate();
  const nameOf = useNameOf();
  return (
    <div
      className={`mt-1 w-full max-w-md overflow-hidden rounded-2xl rounded-tl-sm border border-line ${
        mine ? "bg-primary/10" : "bg-surface-sidebar"
      }`}
      data-meeting-card={card.eventId}
    >
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        <CalendarIcon className="text-primary" aria-hidden="true" />
        Meeting scheduled
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-base font-semibold leading-snug text-ink">{card.title}</p>
        <p className="text-sm text-ink">
          <time dateTime={new Date(card.startAt).toISOString()}>
            {formatWhen({ ...card, type: "meeting" } as Parameters<typeof formatWhen>[0])}
          </time>
        </p>
        {card.description && (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">
            {card.description}
          </p>
        )}
        <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span className="flex -space-x-1" aria-hidden="true">
            {card.participants.map((id) => (
              <span key={id} className="rounded-lg ring-2 ring-surface">
                <Avatar name={nameOf(id)} size="xs" mine={id === myUserId} />
              </span>
            ))}
          </span>
          <span className="truncate">
            {card.participants.map((id) => (id === myUserId ? "You" : nameOf(id))).join(" and ")}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void navigate(calendarEventPath(card.eventId))}
        className="flex w-full items-center justify-between border-t border-line/70 px-3 py-2 text-sm font-semibold text-ink hover:bg-surface-hover"
      >
        View in Calendar
        <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
      </button>
    </div>
  );
}
