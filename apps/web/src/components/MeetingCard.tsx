import type { MeetingCard as MeetingCardData } from "@mindfultech/shared";
import { useNavigate } from "react-router-dom";
import { joinState } from "../lib/agenda";
import { calls, useCall } from "../lib/call";
import { formatWhen } from "../lib/calendarUi";
import { useNow } from "../lib/hooks";
import { useChat, useNameOf } from "../store";
import { Avatar } from "./Avatar";
import { CalendarIcon, ChevronRightIcon, VideoIcon } from "./icons";

/** Where the calendar opens this card's event. */
export const calendarEventPath = (eventId: string) =>
  `/app/calendar?event=${encodeURIComponent(eventId)}`;

/**
 * A "meeting scheduled" message: a card instead of a text bubble, with the
 * title, when (in the viewer's local time), the details, the two people and
 * a button that opens the live event in the calendar. From five minutes
 * before the start until the end, a "Join call" button starts the video
 * call with the other person right from the card (the clock is re-read
 * every minute, so the button appears on its own). The card is a snapshot
 * from when the meeting was scheduled; the calendar is the truth.
 */
export function MeetingCard({
  card,
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
  const inCall = useCall((s) => s.call !== null);
  const now = useNow();
  const join = joinState(card, now);
  // The other person of the DM (yourself in a self-DM).
  const peerId = card.participants.find((id) => id !== myUserId) ?? myUserId;

  function joinCall() {
    if (!peerId) return;
    if (inCall) return showToast("You're already in a call.");
    void calls.startCall(channelId, peerId, "video");
  }

  return (
    <div
      className={`mt-1 w-full max-w-md overflow-hidden rounded-2xl rounded-tl-sm border border-line ${
        mine ? "bg-primary/10" : "bg-surface-sidebar"
      }`}
      data-meeting-card={card.eventId}
      data-join={join}
    >
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        <CalendarIcon className="text-primary" aria-hidden="true" />
        Meeting scheduled
        {join === "open" && (
          <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal text-success">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {now >= card.startAt ? "Happening now" : "Starts soon"}
          </span>
        )}
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
