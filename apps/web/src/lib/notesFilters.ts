import { NOTES_CATEGORIES, type Message, type NotesCategory } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// The AI Notes hub's filters (Phase 46): by category, by topic and by words,
// over the cards loaded so far. Pure, tested.
// ---------------------------------------------------------------------------

export interface NotesFilter {
  /** "" for every category; "unfiled" for cards without one yet. */
  category: NotesCategory | "unfiled" | "";
  /** "" for every topic; compared case- and accent-insensitively. */
  topic: string;
  /** Free text: the summary, the topics and the other person's name. */
  query: string;
}

export const NO_FILTER: NotesFilter = { category: "", topic: "", query: "" };

/** Lower case, without accents or extra spaces: "Facturación " and "facturacion" are one. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const notesOf = (m: Message) => m.aiNotes;

/** Whether `message` passes `filter`; `peerName` is who the call was with. */
export function matchesNotesFilter(message: Message, filter: NotesFilter, peerName = ""): boolean {
  const notes = notesOf(message);
  if (!notes) return false;
  if (
    filter.category === "unfiled"
      ? notes.category
      : filter.category && notes.category !== filter.category
  ) {
    return false;
  }
  const topics = (notes.topics ?? []).map(fold);
  if (filter.topic && !topics.includes(fold(filter.topic))) return false;
  const words = fold(filter.query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold([notes.summary, ...(notes.topics ?? []), peerName].join(" "));
  return words.every((w) => haystack.includes(w));
}

/** How many cards each category has (only the ones with any), in `NOTES_CATEGORIES` order. */
export function categoryCounts(
  messages: Message[],
): Array<{ category: NotesCategory; count: number }> {
  const counts = new Map<NotesCategory, number>();
  for (const m of messages) {
    const c = notesOf(m)?.category;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return NOTES_CATEGORIES.filter((c) => counts.has(c)).map((category) => ({
    category,
    count: counts.get(category)!,
  }));
}

/**
 * The most used topics among `messages`, most used first (ties by name),
 * at most `limit`. Topics that differ only in case or accents are one, shown
 * as first written.
 */
export function topTopics(
  messages: Message[],
  limit = 12,
): Array<{ topic: string; count: number }> {
  const byKey = new Map<string, { topic: string; count: number }>();
  for (const m of messages) {
    for (const topic of new Set(notesOf(m)?.topics ?? [])) {
      const key = fold(topic);
      if (!key) continue;
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { topic, count: 1 });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, limit);
}

/** Ready cards still waiting for a category or (Phase 48) a title: "Organize" fills them in. */
export const unfiledCount = (messages: Message[]): number =>
  messages.filter((m) => {
    const notes = notesOf(m);
    return notes?.status === "ready" && (!notes.category || !notes.title);
  }).length;

/**
 * The summary's opening paragraph as plain text, for a card's preview: up to
 * the first heading or list (the action items), markdown marks removed.
 */
export function notePreview(summary: string): string {
  const lines: string[] = [];
  for (const raw of summary.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (lines.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line) && lines.length === 0) continue; // a "Summary" heading on top
    if (/^(#{1,6}\s|[-*+•]\s|\d+[.)]\s)/.test(line)) break;
    lines.push(line);
  }
  return lines
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A card's heading: the AI's title, else its first topic, else who the call was with. */
export function noteTitle(message: Message, peerName: string): string {
  const notes = notesOf(message);
  return notes?.title || notes?.topics?.[0] || (peerName ? `Call with ${peerName}` : "Call");
}

// --- Phase 50: the hub's date groups -----------------------------------------------

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
] as const;

/** Local midnight of `ts`, `days` later (calendar days, so a DST change doesn't matter). */
const dayStart = (ts: number, days = 0) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
};

export interface NoteDateGroup {
  key: string;
  label: string;
}

/**
 * The hub's heading for a meeting at `ts`: "Hoy", "Ayer", "Esta semana"
 * (from Monday), then the month ("Octubre 2026"). Newest-first notes fall
 * into these in order.
 */
export function noteDateGroup(ts: number, now = Date.now()): NoteDateGroup {
  const today = dayStart(now);
  if (ts >= today) return { key: "today", label: "Hoy" };
  if (ts >= dayStart(now, -1)) return { key: "yesterday", label: "Ayer" };
  const weekday = (new Date(now).getDay() + 6) % 7; // Monday 0 … Sunday 6
  if (ts >= dayStart(now, -weekday)) return { key: "week", label: "Esta semana" };
  const d = new Date(ts);
  return {
    key: `${d.getFullYear()}-${d.getMonth()}`,
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  };
}

/** `items` (newest first) under their date headings, in order. */
export function groupByNoteDate<T>(
  items: T[],
  timeOf: (item: T) => number,
  now = Date.now(),
): Array<NoteDateGroup & { items: T[] }> {
  const groups: Array<NoteDateGroup & { items: T[] }> = [];
  for (const item of items) {
    const group = noteDateGroup(timeOf(item), now);
    const last = groups.at(-1);
    if (last?.key === group.key) last.items.push(item);
    else groups.push({ ...group, items: [item] });
  }
  return groups;
}

const shortDay = new Intl.DateTimeFormat("es", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** When a meeting was, for its card: the time today and yesterday, the day before that. */
export function noteWhen(ts: number, formatTime: (ts: number) => string, now = Date.now()): string {
  const { key } = noteDateGroup(ts, now);
  if (key === "today" || key === "yesterday") return formatTime(ts);
  // "lun, 2 nov" in some engines, "lun 2 nov" in others: the same without the comma.
  const day = shortDay.format(ts).replace(",", "").replace(/\.$/, "");
  return `${day} · ${formatTime(ts)}`;
}
