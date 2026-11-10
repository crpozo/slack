import { z } from "zod";
import type { Channel } from "./protocol";
import type { Role } from "./roles";

// ---------------------------------------------------------------------------
// Hours (Phase 60): a time log per channel. Whoever works on the project
// (a teammate, or an external such as a contractor) logs what they did each
// day and how long it took. Admins set each person's hourly rate in that
// channel and see what the work costs, live. Rates and costs are the admins'
// alone; an external sees only their own entries.
// ---------------------------------------------------------------------------

/** A day's entry is at most this long, and at least a minute. */
export const MAX_ENTRY_MINUTES = 24 * 60;
export const MAX_ENTRY_DESCRIPTION = 500;
export const MAX_HOURLY_RATE = 10_000;
/** Rates and costs are in US dollars (Ecuador's currency). */
export const TIME_LOG_CURRENCY = "USD";

export interface TimeEntry {
  entryId: string;
  channelId: string;
  userId: string;
  /** Their name when they logged it (an external may leave the directory). */
  userName: string;
  /** The day worked, `YYYY-MM-DD`. */
  date: string;
  minutes: number;
  /** What was done. */
  description: string;
  /** Epoch ms. */
  createdAt: number;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const CreateTimeEntrySchema = z.object({
  date: day,
  minutes: z.number().int().min(1).max(MAX_ENTRY_MINUTES),
  description: z.string().trim().min(1).max(MAX_ENTRY_DESCRIPTION),
});
export type CreateTimeEntryInput = z.infer<typeof CreateTimeEntrySchema>;

/** An hourly rate in dollars (cents allowed); 0 clears it. */
export const SetTimeRateSchema = z.object({
  hourlyRate: z
    .number()
    .min(0)
    .max(MAX_HOURLY_RATE)
    .refine((n) => Math.round(n * 100) === n * 100, "at most two decimals"),
});

/** `GET /channels/{channelId}/time`. */
export interface TimeLogResponse {
  /** Newest day first. An external gets only their own. */
  entries: TimeEntry[];
  /** Admins only: each person's hourly rate in this channel (dollars), by user id. */
  rates?: Record<string, number>;
}

/** Pushed to the channel when its log changes: clients read it again. */
export interface TimeLogUpdatedEvent {
  type: "time.updated";
  channelId: string;
}

/** Who may log hours in `channel`: anyone in it (teammates and externals), never in a DM. */
export const canLogTime = (channel: Pick<Channel, "type" | "archived">): boolean =>
  channel.type !== "dm" && !channel.archived;

/** Whose entries someone sees: an external only their own; the team everyone's. */
export const seesAllTime = (role: Role | undefined): boolean => role !== "guest";

/** Who sees and sets rates, and sees costs: admins. */
export const managesTimeRates = (role: Role | undefined): boolean => role === "admin";

/** Who may delete an entry: whoever logged it, or an admin. */
export const canDeleteTimeEntry = (
  entry: Pick<TimeEntry, "userId">,
  userId: string,
  role: Role | undefined,
): boolean => entry.userId === userId || role === "admin";

/** "2h 30m", "45m", "8h". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * What someone typed as a duration, in minutes: "2", "2.5", "2,5", "2h",
 * "2h 30m", "2:30", "45m", "90 min". `null` when it isn't one.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase().replace(",", ".");
  if (!text) return null;
  let minutes: number;
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  const parts = /^(?:(\d+(?:\.\d+)?)\s*h(?:oras?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utos?)?)?)?$/.exec(
    text,
  );
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else if (/^\d+(\.\d+)?$/.test(text))
    minutes = Number(text) * 60; // a bare number: hours
  else if (parts && (parts[1] !== undefined || parts[2] !== undefined)) {
    minutes = Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
  } else return null;
  minutes = Math.round(minutes);
  return minutes >= 1 && minutes <= MAX_ENTRY_MINUTES ? minutes : null;
}

/** What `minutes` cost at `hourlyRate` dollars, to the cent. */
export const costOf = (minutes: number, hourlyRate: number): number =>
  Math.round((minutes / 60) * hourlyRate * 100) / 100;

export interface TimeTotals {
  minutes: number;
  /** Dollars; only what has a rate counts (`unpriced` says what doesn't). */
  cost: number;
  /** Minutes logged by people with no rate set. */
  unpricedMinutes: number;
  byUser: Array<{ userId: string; userName: string; minutes: number; rate?: number; cost: number }>;
}

/** Hours and cost of `entries`, in all and by person (most hours first). */
export function timeTotals(entries: TimeEntry[], rates: Record<string, number> = {}): TimeTotals {
  const people = new Map<string, { userName: string; minutes: number }>();
  for (const e of entries) {
    const p = people.get(e.userId) ?? { userName: e.userName, minutes: 0 };
    p.minutes += e.minutes;
    people.set(e.userId, p);
  }
  const byUser = [...people.entries()]
    .map(([userId, p]) => {
      const rate = rates[userId];
      return {
        userId,
        userName: p.userName,
        minutes: p.minutes,
        ...(rate ? { rate } : {}),
        cost: rate ? costOf(p.minutes, rate) : 0,
      };
    })
    .sort((a, b) => b.minutes - a.minutes || a.userName.localeCompare(b.userName));
  return {
    minutes: byUser.reduce((n, p) => n + p.minutes, 0),
    cost: Math.round(byUser.reduce((n, p) => n + p.cost, 0) * 100) / 100,
    unpricedMinutes: byUser.filter((p) => !p.rate).reduce((n, p) => n + p.minutes, 0),
    byUser,
  };
}
