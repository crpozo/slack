import {
  describeRecurrence,
  dmMembers,
  meetingCardOf,
  meetingStartDate,
  nextOccurrence,
  type MeetingCard as MeetingCardData,
  type MeetingEvent,
} from "@mindfultech/shared";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { joinState } from "../lib/agenda";
import { calls, useCall } from "../lib/call";
import { groupCalls, useGroupCall } from "../lib/groupCall";
import { formatWhen } from "../lib/calendarUi";
import { useNow } from "../lib/hooks";
import { useChat, useNameOf } from "../store";
import { useCalendar } from "../store/calendar";
import { Avatar } from "./Avatar";
import { CalendarIcon, ChevronRightIcon, RepeatIcon, VideoIcon } from "./icons";

/** Where the calendar opens this card's event. */
export const calendarEventPath = (eventId: string) =>
  `/app/calendar?event=${encodeURIComponent(eventId)}`;

/**
 * A "meeting scheduled" message: a card instead of a text bubble, with the
 * title, when (in the viewer's local time), the details, the two people and
 * a button that opens the live event in the calendar. From five minutes
 * before the start until the end, a "Join call" button starts the video
 * call with the other person right from the card (the clock is re-read
 * every minute, so the button appears on its own).
 *
 * A living card: the server rewrites the message's card whenever the meeting
 * is edited (`message.updated`), and when the calendar store already holds
 * the live event (the calendar was opened, or its push arrived first), the
 * card is drawn from that, so the two never disagree.
 *
 * Phase 34: a series' card shows its meeting happening now or next (Join
 * opens for each one), and says how it repeats; a deleted meeting's card
 * stays, marked cancelled. Cards of group meetings sit in each invitee's DM
 * with the organizer: Join calls the other person of that DM.
 */
export function MeetingCard({
  card: stored,
  channelId,
  mine,
  myUserId,
}: Readonly<{
  card: MeetingCardData;
  channelId: string;
  mine: boolean;
  myUserId: string | undefined;
}>) {
  const navigate = useNavigate();
  const nameOf = useNameOf();
  const showToast = useChat((s) => s.showToast);
  const inDmCall = useCall((s) => s.call !== null);
  const inGroupCall = useGroupCall((s) => s.call !== null);
  const inCall = inDmCall || inGroupCall;
  const live = useCalendar((s) => s.events[stored.eventId]);
  // A cancelled card stays cancelled, whatever the calendar still holds.
  const card = useMemo(
    () => (live?.type === "meeting" && !stored.cancelled ? meetingCardOf(live) : stored),
    [live, stored],
  );
  const now = useNow();
  // The meeting to show: a series' current or next one (`null` once it's over).
  const shown = useMemo(
    () => (card.recurrence ? nextOccurrence(asMeeting(card), now) : card),
    [card, now],
  );
  const over = !!card.recurrence && shown === null;
  const when = shown ?? card;
  // An all-day or cancelled meeting has no call to join.
  const join = card.allDay || card.cancelled || !shown ? "upcoming" : joinState(shown, now);
  // The other person of this DM (yourself in a self-DM).
  const dm = dmMembers(channelId);
  const peerId =
    dm?.find((id) => id !== myUserId) ??
    card.participants.find((id) => id !== myUserId) ??
    myUserId;
  const heading = card.cancelled
    ? "Meeting cancelled"
    : card.recurrence
      ? "Repeating meeting"
      : "Meeting scheduled";

  function joinCall() {
    if (inCall) return showToast("You're already in a call.");
    // A channel's meeting (Phase 36): its call is the channel's.
    if (!dm) return void groupCalls.join(channelId, "video");
    if (!peerId) return;
    void calls.startCall(channelId, peerId, "video");
  }

  return (
    <div
      className={`mt-1 w-full max-w-md overflow-hidden rounded-2xl rounded-tl-sm border border-line ${
        mine ? "bg-primary/10" : "bg-surface-sidebar"
      }`}
      data-meeting-card={card.eventId}
      data-join={join}
      data-cancelled={card.cancelled ? "true" : undefined}
    >
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        {card.recurrence && !card.cancelled ? (
          <RepeatIcon className="text-primary" aria-hidden="true" />
        ) : (
          <CalendarIcon
            className={card.cancelled ? "text-ink-secondary" : "text-primary"}
            aria-hidden="true"
          />
        )}
        {heading}
        {join === "open" && (
          <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal text-success">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {now >= when.startAt ? "Happening now" : "Starts soon"}
          </span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <p
          className={`text-base font-semibold leading-snug ${
            card.cancelled ? "text-ink-secondary line-through" : "text-ink"
          }`}
        >
          {card.title}
        </p>
        {card.recurrence && (
          <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <RepeatIcon aria-hidden="true" />
            {describeRecurrence(card.recurrence, meetingStartDate(card))}
          </p>
        )}
        {over ? (
          <p className="text-sm text-ink-secondary">This series has ended.</p>
        ) : (
          !card.cancelled && (
            <p className="text-sm text-ink">
              {card.recurrence && <span className="text-ink-secondary">Next: </span>}
              <time dateTime={new Date(when.startAt).toISOString()}>
                {formatWhen({ ...when, type: "meeting" } as Parameters<typeof formatWhen>[0])}
                {card.allDay && " (all day)"}
              </time>
            </p>
          )
        )}
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
            {listOf(card.participants.map((id) => (id === myUserId ? "You" : nameOf(id))))}
          </span>
        </div>
        {join === "open" && (
          <button
            type="button"
            onClick={joinCall}
            disabled={inCall}
            className="btn-primary w-full"
            aria-label={`Join the video call for ${card.title}`}
          >
            <VideoIcon /> Join call
          </button>
        )}
      </div>
      {!card.cancelled && (
        <button
          type="button"
          onClick={() => void navigate(calendarEventPath(card.eventId))}
          className="flex w-full items-center justify-between border-t border-line/70 px-3 py-2 text-sm font-semibold text-ink hover:bg-surface-hover"
        >
          View in Calendar
          <ChevronRightIcon className="text-ink-secondary" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** A card's fields as the meeting they describe (what the series helpers read). */
const asMeeting = (card: MeetingCardData): MeetingEvent => ({
  ...card,
  type: "meeting",
  createdBy: "",
  createdAt: 0,
  updatedAt: 0,
});

/** "You", "You and Ana", "You, Ana and Luis". */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
