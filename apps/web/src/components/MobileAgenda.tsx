import { addDays, dateInZone, type CalendarEvent } from "@mindfultech/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addMonths,
  eventsByDate,
  monthDays,
  monthOf,
  monthsRange,
  monthTitle,
  type MonthKey,
} from "../lib/agenda";
import { eventLabel } from "../lib/calendarUi";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** Dot and pill colors per event kind, on the same tokens as the desktop grid. */
function tone(e: CalendarEvent): { dot: string; pill: string } {
  if (e.type === "holiday") return { dot: "bg-error", pill: "bg-error/15" };
  if (e.type === "vacation") {
    return e.status === "pending"
      ? { dot: "border border-dashed border-success bg-success/30", pill: "bg-success/10" }
      : { dot: "bg-success", pill: "bg-success/15" };
  }
  return { dot: "bg-primary", pill: "bg-primary/15" };
}

function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

interface MobileAgendaProps {
  events: CalendarEvent[];
  holidays: ReadonlySet<string>;
  nameOf: (userId: string) => string;
  /** Called with the month whose header is at the top, for the page title. */
  onMonthChange: (month: MonthKey) => void;
  /** More months scrolled into view: load their events. */
  onRangeChange: (from: string, to: string) => void;
  onSelectEvent: (eventId: string) => void;
  onNewEvent: (date: string) => void;
  /** Scroll this date into view (a deep link); `null` for none. */
  focusDate: string | null;
  /** Bumped by the "Today" control to scroll back to today. */
  todayNonce: number;
}

/**
 * The phone calendar: every day of the month as a row in one continuous,
 * vertically scrolling list (earlier months above, later below, loaded as
 * you reach them), each with its events as colored pills. Today wears a
 * filled circle, like iOS. Tapping a day's empty space starts a new event
 * on it; tapping a pill opens the event.
 */
export function MobileAgenda({
  events,
  holidays,
  nameOf,
  onMonthChange,
  onRangeChange,
  onSelectEvent,
  onNewEvent,
  focusDate,
  todayNonce,
}: Readonly<MobileAgendaProps>) {
  const today = dateInZone(Date.now());
  const [months, setMonths] = useState<MonthKey[]>(() => {
    const current = monthOf(today);
    return [addMonths(current, -1), current, addMonths(current, 1)];
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [todayVisible, setTodayVisible] = useState(true);
  const byDate = useMemo(() => eventsByDate(events), [events]);

  // The events of every month on screen (fetched once per range; pushes keep them fresh).
  useEffect(() => {
    const { from, to } = monthsRange(months);
    onRangeChange(from, to);
  }, [months, onRangeChange]);

  const scrollTo = (date: string, behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-date="${date}"]`);
    el?.scrollIntoView({ block: "start", behavior });
  };

  // Open on today; come back to it on "Today"; jump to a deep-linked date.
  useLayoutEffect(() => {
    scrollTo(today);
  }, []);
  useEffect(() => {
    if (todayNonce > 0) scrollTo(today, "smooth");
  }, [todayNonce]);
  useEffect(() => {
    if (!focusDate) return;
    const month = monthOf(focusDate);
    if (!months.includes(month)) {
      // Extend the window to that month, then the next effect run scrolls.
      setMonths((list) => {
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (month < first) {
          const out = [...list];
          for (let m = addMonths(first, -1); m >= month; m = addMonths(m, -1)) out.unshift(m);
          return out;
        }
        const out = [...list];
        for (let m = addMonths(last, 1); m <= month; m = addMonths(m, 1)) out.push(m);
        return out;
      });
      return;
    }
    scrollTo(focusDate, "smooth");
  }, [focusDate, months]);

  // Reaching either end adds a month there. Prepending keeps the viewport still
  // by restoring the scroll offset against the new scrollHeight.
  useEffect(() => {
    const root = scrollRef.current;
    const top = topRef.current;
    const bottom = bottomRef.current;
    if (!root || !top || !bottom) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === top) {
            const before = root.scrollHeight;
            setMonths((list) => [addMonths(list[0]!, -1), ...list]);
            requestAnimationFrame(() => {
              root.scrollTop += root.scrollHeight - before;
            });
          } else {
            setMonths((list) => [...list, addMonths(list[list.length - 1]!, 1)]);
          }
        }
      },
      { root, rootMargin: "300px 0px" },
    );
    observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);

  // The month at the top of the viewport names the page; today's row decides the "Today" pill.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const headers = root.querySelectorAll<HTMLElement>("[data-month]");
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const month = (entry.target as HTMLElement).dataset.month!;
          if (entry.isIntersecting) visible.set(month, entry.boundingClientRect.top);
          else visible.delete(month);
        }
        const rootTop = root.getBoundingClientRect().top;
        // Topmost visible header, else the month of the first visible day row.
        const sorted = [...visible.entries()].sort((a, b) => a[1] - b[1]);
        const first = sorted[0];
        if (first && first[1] - rootTop < 80) return onMonthChange(first[0]);
        const row = [...root.querySelectorAll<HTMLElement>("[data-date]")].find(
          (n) => n.getBoundingClientRect().bottom > rootTop,
        );
        if (row?.dataset.date) onMonthChange(monthOf(row.dataset.date));
      },
      { root, threshold: 0 },
    );
    headers.forEach((h) => observer.observe(h));
    const todayRow = root.querySelector<HTMLElement>(`[data-date="${today}"]`);
    const todayObserver = new IntersectionObserver(([e]) => setTodayVisible(!!e?.isIntersecting), {
      root,
    });
    if (todayRow) todayObserver.observe(todayRow);
    return () => {
      observer.disconnect();
      todayObserver.disconnect();
    };
  }, [months, onMonthChange, today]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
        role="list"
        aria-label="Days"
      >
        <div ref={topRef} className="h-px" aria-hidden="true" />
        {months.map((month) => (
          <section key={month} aria-label={monthTitle(month)}>
            <h2
              data-month={month}
              className="sticky top-0 z-10 border-b border-line bg-surface/95 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary backdrop-blur"
            >
              {monthTitle(month)}
            </h2>
            {monthDays(month).map((date) => {
              const list = byDate.get(date) ?? [];
              const isToday = date === today;
              const holiday = holidays.has(date);
              return (
                <div
                  key={date}
                  data-date={date}
                  role="listitem"
                  // scroll-mt: scrolled-to rows land below the sticky month header.
                  className={`flex scroll-mt-8 gap-3 border-b border-line/60 px-4 ${
                    list.length > 0 ? "py-2.5" : "py-1.5"
                  } ${holiday ? "bg-error/5" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => onNewEvent(date)}
                    className="flex w-12 shrink-0 flex-col items-center pt-0.5"
                    aria-label={`New event on ${weekday(date)} ${date}`}
                  >
                    <span
                      className={`text-[11px] font-medium uppercase ${
                        isToday ? "text-error" : holiday ? "text-error/80" : "text-ink-secondary"
                      }`}
                    >
                      {weekday(date)}
                    </span>
                    <span
                      className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-base font-semibold ${
                        isToday ? "bg-error text-white" : "text-ink"
                      }`}
                    >
                      {Number(date.slice(8))}
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    {list.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => onNewEvent(date)}
                        className="block h-full w-full py-3 text-left text-xs text-ink-secondary/60"
                        aria-label={`New event on ${date}`}
                      >
                        {isToday ? "Nothing today" : ""}
                      </button>
                    ) : (
                      <ul className="space-y-1">
                        {list.map((e) => {
                          const t = tone(e);
                          const timed = e.type === "meeting" && !e.allDay;
                          return (
                            <li key={e.eventId}>
                              <button
                                type="button"
                                onClick={() => onSelectEvent(e.eventId)}
                                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${t.pill} active:brightness-95`}
                              >
                                <span
                                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${t.dot}`}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                                  {eventLabel(e, nameOf)}
                                </span>
                                <span className="shrink-0 text-xs tabular-nums text-ink-secondary">
                                  {timed
                                    ? `${timeFmt.format(e.startAt)} – ${timeFmt.format(e.endAt)}`
                                    : "all day"}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        <div ref={bottomRef} className="h-px" aria-hidden="true" />
        <div className="h-24" aria-hidden="true" />
      </div>
      {!todayVisible && (
        <button
          type="button"
          onClick={() => scrollTo(today, "smooth")}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface-raised px-4 py-1.5 text-sm font-semibold text-error shadow-md"
        >
          Today · {weekday(today)} {Number(addDays(today, 0).slice(8))}
        </button>
      )}
    </div>
  );
}
