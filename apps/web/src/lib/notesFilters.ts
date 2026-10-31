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

/** Ready cards still waiting for a category (written before Phase 46). */
export const unfiledCount = (messages: Message[]): number =>
  messages.filter((m) => notesOf(m)?.status === "ready" && !notesOf(m)?.category).length;
