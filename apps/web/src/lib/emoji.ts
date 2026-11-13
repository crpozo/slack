import { MAX_EMOJI_LENGTH } from "@mindfultech/shared";

export interface EmojiItem {
  emoji: string;
  label: string;
  /** Lowercased label + tags, accent-free, for search. */
  search: string;
  /** Phase 66: its five skin-tone variants, light to dark (hands, people). */
  skins?: string[];
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

/** Phase 66: the picker's own section, before the standard ones. */
export const WORK_GROUP_ID = -1;
/** What a team reaches for all day, in the order they're offered. */
const WORK_EMOJIS = [
  "✅",
  "👀",
  "🙌",
  "🙏",
  "➕",
  "👏",
  "💡",
  "🎯",
  "👋",
  "👍",
  "🎉",
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "📣",
  "⚪",
  "🔵",
  "🔴",
  "🚀",
  "🔥",
  "⏳",
  "📌",
  "🐛",
  "✍",
  "🤝",
  "☕",
  "🏠",
  "🏢",
  "💻",
  "📅",
  "🧠",
  "🤖",
  "⚠",
  "❓",
  "💬",
  "📎",
];
const bare = (emoji: string) => emoji.replace(/\uFE0F/g, "");

const GROUP_LABELS: Record<number, string> = {
  [WORK_GROUP_ID]: "Getting Work Done",
  // People (the dataset's group 1) are listed with the smileys, as one section.
  0: "Smileys & People",
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
  skins?: Array<{ unicode: string }>;
}

/**
 * Groups the emojibase dataset for the picker (skin-tone components and odd
 * entries dropped): "Getting Work Done" first, then the standard sections,
 * people together with the smileys.
 */
export function buildGroups(raw: RawEmoji[]): EmojiGroup[] {
  const groups = new Map<number, EmojiItem[]>();
  const byBare = new Map<string, EmojiItem>();
  for (const e of [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (e.group === undefined) continue;
    const group = e.group === 1 ? 0 : e.group;
    if (!(group in GROUP_LABELS)) continue;
    if (e.unicode.length > MAX_EMOJI_LENGTH) continue;
    const skins = e.skins?.map((skin) => skin.unicode) ?? [];
    const item: EmojiItem = {
      emoji: e.unicode,
      label: e.label,
      search: normalizeSearch([e.label, ...(e.tags ?? [])].join(" ")),
      // One tone per variant only (a couple with two tones has 25: left as it is).
      ...(skins.length === 5 &&
        skins.every((skin) => skin.length <= MAX_EMOJI_LENGTH) && { skins }),
    };
    byBare.set(bare(item.emoji), item);
    const list = groups.get(group);
    if (list) list.push(item);
    else groups.set(group, [item]);
  }
  // The dataset's own strings, so a ✅ picked here and one picked below are one reaction.
  const work = WORK_EMOJIS.map((emoji) => byBare.get(bare(emoji))).filter(
    (item): item is EmojiItem => item !== undefined,
  );
  if (work.length > 0) groups.set(WORK_GROUP_ID, work);
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, emojis]) => ({ id, label: GROUP_LABELS[id] ?? "", emojis }));
}

/** The emoji in `tone` (0: the default yellow; 1–5: light to dark), where it has tones. */
export function inSkinTone(item: Pick<EmojiItem, "emoji" | "skins">, tone: number): string {
  return (tone > 0 && item.skins?.[tone - 1]) || item.emoji;
}

export function searchEmojis(groups: EmojiGroup[], query: string, limit = 120): EmojiItem[] {
  const q = normalizeSearch(query);
  if (!q) return [];
  const words = q.split(/\s+/);
  const result: EmojiItem[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group.emojis) {
      if (seen.has(item.emoji)) continue; // the work section repeats some
      if (words.every((w) => item.search.includes(w))) {
        result.push(item);
        seen.add(item.emoji);
      }
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

// Phase 66: "Frequently Used" (what this person picks most) and their skin tone.

const COUNTS_KEY = "slack.emojiCounts";
const SKIN_KEY = "slack.emojiSkinTone";
const FREQUENT_MAX = 18;

function loadCounts(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COUNTS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Counts a pick (and keeps it among the recents). */
export function countEmoji(emoji: string): void {
  rememberEmoji(emoji);
  try {
    const counts = loadCounts();
    counts[emoji] = (Number(counts[emoji]) || 0) + 1;
    // Keep the list bounded: the least used go first.
    const kept = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 80);
    localStorage.setItem(COUNTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // A nicety.
  }
}

/** The most picked emoji, most used first; ties and the rest by how recently they were used. */
export function frequentEmojis(): string[] {
  const counts = loadCounts();
  const recent = loadRecentEmojis();
  const position = (emoji: string) => {
    const i = recent.indexOf(emoji);
    return i === -1 ? recent.length : i;
  };
  return [...new Set([...Object.keys(counts), ...recent])]
    .sort(
      (a, b) => (Number(counts[b]) || 0) - (Number(counts[a]) || 0) || position(a) - position(b),
    )
    .slice(0, FREQUENT_MAX);
}

export function loadSkinTone(): number {
  try {
    const tone = Number(localStorage.getItem(SKIN_KEY));
    return Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
  } catch {
    return 0;
  }
}

export function saveSkinTone(tone: number): void {
  try {
    localStorage.setItem(SKIN_KEY, String(tone));
  } catch {
    // Kept for this session only.
  }
}
