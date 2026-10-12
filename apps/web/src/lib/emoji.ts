import { MAX_EMOJI_LENGTH } from "@mindfultech/shared";

export interface EmojiItem {
  emoji: string;
  label: string;
  /** Lowercased label + tags, accent-free, for search. */
  search: string;
}

export interface EmojiGroup {
  id: number;
  label: string;
  emojis: EmojiItem[];
}

/**
 * One-click reactions. Strings match the emojibase dataset exactly (including
 * U+FE0F variation selectors) so a quick 👍 and a picked 👍 are the same reaction.
 */
export const QUICK_REACTIONS = ["👍️", "❤️", "😂", "🎉", "😮", "🙏"] as const;

const GROUP_LABELS: Record<number, string> = {
  0: "Smileys & emotion",
  1: "People",
  3: "Animals & nature",
  4: "Food & drink",
  5: "Travel & places",
  6: "Activities",
  7: "Objects",
  8: "Symbols",
  9: "Flags",
};

export function normalizeSearch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

interface RawEmoji {
  unicode: string;
  label: string;
  group?: number;
  order?: number;
  tags?: string[];
}

/** Groups the emojibase dataset for the picker (skin-tone components and odd entries dropped). */
export function buildGroups(raw: RawEmoji[]): EmojiGroup[] {
  const groups = new Map<number, EmojiItem[]>();
  for (const e of [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (e.group === undefined || !(e.group in GROUP_LABELS)) continue;
    if (e.unicode.length > MAX_EMOJI_LENGTH) continue;
    const item = {
      emoji: e.unicode,
      label: e.label,
      search: normalizeSearch([e.label, ...(e.tags ?? [])].join(" ")),
    };
    const list = groups.get(e.group);
    if (list) list.push(item);
    else groups.set(e.group, [item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, emojis]) => ({ id, label: GROUP_LABELS[id] ?? "", emojis }));
}

export function searchEmojis(groups: EmojiGroup[], query: string, limit = 120): EmojiItem[] {
  const q = normalizeSearch(query);
  if (!q) return [];
  const words = q.split(/\s+/);
  const result: EmojiItem[] = [];
  for (const group of groups) {
    for (const item of group.emojis) {
      if (words.every((w) => item.search.includes(w))) result.push(item);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

let groupsPromise: Promise<EmojiGroup[]> | undefined;

/** Loads the English emoji dataset on first use (its own lazily-loaded chunk). */
export function loadEmojiGroups(): Promise<EmojiGroup[]> {
  groupsPromise ??= import("emojibase-data/en/compact.json").then((mod) =>
    buildGroups((mod as unknown as { default: RawEmoji[] }).default),
  );
  return groupsPromise;
}

const RECENT_KEY = "slack.recentEmojis";
const RECENT_MAX = 16;

export function loadRecentEmojis(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string, recent: string[] = loadRecentEmojis()): string[] {
  const next = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recents are a nicety.
  }
  return next;
}
