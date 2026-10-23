import {
  addDays,
  dayOfWeek,
  describeRecurrence,
  MAX_RECURRENCE_COUNT,
  MAX_RECURRENCE_DAYS,
  MAX_RECURRENCE_INTERVAL,
  type Recurrence,
  type RecurrenceFrequency,
} from "@mindfultech/shared";
import { useEffect, useId, useState } from "react";
import { RepeatIcon } from "./icons";

// ---------------------------------------------------------------------------
// "Repeat" for a meeting (Phase 34): the usual presets (daily, every weekday,
// weekly on the start's day, monthly on its date) or a custom rule (every N
// days/weeks/months, chosen weekdays), and when the series ends. Controlled:
// the rule is the parent's (`null` = doesn't repeat).
// ---------------------------------------------------------------------------

type Preset = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const UNITS: Record<RecurrenceFrequency, [one: string, many: string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
};

const ordinal = (n: number) => {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** Which preset `rule` is, given the first meeting's date. */
export function presetOf(rule: Recurrence | null, first: string): Preset {
  if (!rule) return "none";
  if (rule.interval !== 1) return "custom";
  if (rule.freq === "daily") return "daily";
  if (rule.freq === "monthly") return "monthly";
  const days = rule.byWeekday ?? [];
  if (days.join() === "1,2,3,4,5") return "weekdays";
  if (days.length === 1 && days[0] === dayOfWeek(first)) return "weekly";
  return "custom";
}

/** The rule of a preset (keeping how it ends). */
export function ruleOf(
  preset: Preset,
  first: string,
  ends: Partial<Recurrence>,
): Recurrence | null {
  const end =
    ends.until !== undefined ? { until: ends.until } : ends.count ? { count: ends.count } : {};
  switch (preset) {
    case "none":
      return null;
    case "daily":
      return { freq: "daily", interval: 1, ...end };
    case "weekdays":
      return { freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5], ...end };
    case "weekly":
    case "custom":
      return { freq: "weekly", interval: 1, byWeekday: [dayOfWeek(first)], ...end };
    case "monthly":
      return { freq: "monthly", interval: 1, ...end };
  }
}

/** `rule` with the first meeting's weekday among its days (a weekly series always has it). */
export function withFirstWeekday(rule: Recurrence, first: string, single: boolean): Recurrence {
  if (rule.freq !== "weekly") return rule;
  const dow = dayOfWeek(first);
  if (rule.byWeekday?.includes(dow)) return rule;
  const byWeekday = single ? [dow] : [...(rule.byWeekday ?? []), dow].sort((a, b) => a - b);
  return { ...rule, byWeekday };
}

export function RepeatFields({
  first,
  value,
  onChange,
  disabled,
}: Readonly<{
  /** `YYYY-MM-DD` (company timezone) of the first meeting. */
  first: string;
  value: Recurrence | null;
  onChange: (rule: Recurrence | null) => void;
  disabled?: boolean;
}>) {
  const id = useId();
  const [preset, setPreset] = useState<Preset>(() => presetOf(value, first));
  const dow = dayOfWeek(first);

  // A new start date: a weekly series follows it to its weekday.
  useEffect(() => {
    if (!value || value.freq !== "weekly" || value.byWeekday?.includes(dayOfWeek(first))) return;
    onChange(withFirstWeekday(value, first, preset === "weekly"));
  }, [first, value, preset, onChange]);

  const choose = (next: Preset) => {
    setPreset(next);
    if (next === "custom" && value) return; // keep the rule, show its details
    onChange(ruleOf(next, first, value ?? {}));
  };
  const patch = (fields: Partial<Recurrence>) => {
    if (!value) return;
    const next: Recurrence = { ...value, ...fields };
    if (next.freq !== "weekly") delete next.byWeekday;
    else next.byWeekday ??= [dow];
    onChange(next);
  };
  const setEnd = (kind: "never" | "until" | "count") => {
    if (!value) return;
    const next: Recurrence = { ...value };
    delete next.until;
    delete next.count;
    if (kind === "until") next.until = addDays(first, 90);
    if (kind === "count") next.count = 10;
    onChange(next);
  };
  const toggleDay = (day: number) => {
    if (!value || day === dow) return; // the first meeting's day stays
    const days = new Set(value.byWeekday ?? [dow]);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    patch({ byWeekday: [...days].sort((a, b) => a - b) });
  };

  const end = value?.until !== undefined ? "until" : value?.count !== undefined ? "count" : "never";
  const monthDay = ordinal(Number(first.slice(8, 10)));

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-repeat`} className="block text-sm font-medium text-ink">
          Repeat
        </label>
        <select
          id={`${id}-repeat`}
          className="input"
          value={preset}
          onChange={(e) => choose(e.target.value as Preset)}
        >
          <option value="none">Doesn&apos;t repeat</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Every weekday (Monday to Friday)</option>
          <option value="weekly">Weekly on {WEEKDAY_NAMES[dow]}</option>
          <option value="monthly">Monthly on the {monthDay}</option>
          <option value="custom">Custom…</option>
        </select>
      </div>

      {value && preset === "custom" && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <label htmlFor={`${id}-interval`}>Every</label>
            <input
              id={`${id}-interval`}
              type="number"
              min={1}
              max={MAX_RECURRENCE_INTERVAL}
              className="input w-20"
              value={value.interval}
              onChange={(e) =>
                patch({
                  interval: Math.min(
                    MAX_RECURRENCE_INTERVAL,
                    Math.max(1, Math.floor(Number(e.target.value) || 1)),
                  ),
                })
              }
            />
            <select
              aria-label="Repeat unit"
              className="input w-auto"
              value={value.freq}
              onChange={(e) => patch({ freq: e.target.value as RecurrenceFrequency })}
            >
              {(Object.keys(UNITS) as RecurrenceFrequency[]).map((freq) => (
                <option key={freq} value={freq}>
                  {UNITS[freq][value.interval === 1 ? 0 : 1]}
                </option>
              ))}
            </select>
          </div>
          {value.freq === "weekly" && (
            <div role="group" aria-label="On these days" className="flex gap-1">
              {WEEKDAY_LETTERS.map((letter, day) => {
                const on = value.byWeekday?.includes(day) ?? day === dow;
                return (
                  <button
                    key={WEEKDAY_NAMES[day]}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY_NAMES[day]}
                    title={
                      day === dow
                        ? `${WEEKDAY_NAMES[day]} (the first meeting's day)`
                        : WEEKDAY_NAMES[day]
                    }
                    onClick={() => toggleDay(day)}
                    className={`h-8 w-8 rounded-full text-xs font-semibold transition-colors ${
                      on
                        ? "bg-primary text-on-accent"
                        : "bg-surface-sidebar text-ink-secondary hover:text-ink"
                    } ${day === dow ? "cursor-default" : ""}`}
                  >
                    {letter}
                  </button>
                );
              })}
            </div>
          )}
          {value.freq === "monthly" && (
            <p className="text-xs text-ink-secondary">
              On the {monthDay}; months without that day are skipped.
            </p>
          )}
        </div>
      )}

      {value && (
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-ink">Ends</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`${id}-end`}
                checked={end === "never"}
                onChange={() => setEnd("never")}
              />
              Never
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`${id}-end`}
                checked={end === "until"}
                onChange={() => setEnd("until")}
              />
              On
            </label>
            {end === "until" && (
              <input
                type="date"
                aria-label="Last date"
                className="input w-auto"
                value={value.until}
                min={first}
                max={addDays(first, MAX_RECURRENCE_DAYS)}
                onChange={(e) => e.target.value && patch({ until: e.target.value })}
              />
            )}
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`${id}-end`}
                checked={end === "count"}
                onChange={() => setEnd("count")}
              />
              After
            </label>
            {end === "count" && (
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  aria-label="Number of meetings"
                  min={2}
                  max={MAX_RECURRENCE_COUNT}
                  className="input w-20"
                  value={value.count}
                  onChange={(e) =>
                    patch({
                      count: Math.min(
                        MAX_RECURRENCE_COUNT,
                        Math.max(2, Math.floor(Number(e.target.value) || 2)),
                      ),
                    })
                  }
                />
                meetings
              </span>
            )}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-ink-secondary" aria-live="polite">
            <RepeatIcon aria-hidden="true" /> {describeRecurrence(value, first)}
          </p>
        </div>
      )}
    </fieldset>
  );
}
