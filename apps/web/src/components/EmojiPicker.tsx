import {
  Flag,
  Hash,
  Leaf,
  Lightbulb,
  ListChecks,
  Plane,
  Clock,
  Smile,
  Trophy,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  countEmoji,
  frequentEmojis,
  inSkinTone,
  loadEmojiGroups,
  loadSkinTone,
  saveSkinTone,
  searchEmojis,
  WORK_GROUP_ID,
  type EmojiGroup,
  type EmojiItem,
} from "../lib/emoji";
import { SearchIcon } from "./icons";

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

const FREQUENT_ID = -2;
/** One tab per section, in the order they're listed. */
const SECTION_ICONS: Record<number, LucideIcon> = {
  [FREQUENT_ID]: Clock,
  [WORK_GROUP_ID]: ListChecks,
  0: Smile,
  3: Leaf,
  4: Utensils,
  5: Plane,
  6: Trophy,
  7: Lightbulb,
  8: Hash,
  9: Flag,
};
const SKIN_SWATCHES = ["👋", "👋🏻", "👋🏼", "👋🏽", "👋🏾", "👋🏿"];
const SKIN_LABELS = ["Default", "Light", "Medium-light", "Medium", "Medium-dark", "Dark"];

function EmojiButton({
  emoji,
  label,
  onPick,
  onHover,
}: Readonly<{
  emoji: string;
  label: string;
  onPick: () => void;
  onHover: (item: { emoji: string; label: string } | null) => void;
}>) {
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => onHover({ emoji, label })}
      onFocus={() => onHover({ emoji, label })}
      title={label}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-2xl leading-none transition-transform hover:scale-110 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      {emoji}
    </button>
  );
}

/**
 * The emoji picker (rebuilt in Phase 66): a tab per section along the top
 * that jumps to it and follows the scroll, a search over every emoji's name
 * and keywords, "Frequently Used" and "Getting Work Done" first, every
 * standard emoji below, a skin tone for hands and people, and the name of the
 * one under the pointer at the bottom. The dataset loads on first open.
 */
export function EmojiPicker({ onSelect }: Readonly<EmojiPickerProps>) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [frequent] = useState(frequentEmojis);
  const [tone, setTone] = useState(loadSkinTone);
  const [tones, setTones] = useState(false);
  const [hovered, setHovered] = useState<{ emoji: string; label: string } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    let cancelled = false;
    loadEmojiGroups().then(
      (g) => !cancelled && setGroups(g),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => (groups ? searchEmojis(groups, query) : []), [groups, query]);
  const itemOf = useMemo(() => {
    const map = new Map<string, EmojiItem>();
    for (const g of groups ?? []) {
      for (const e of g.emojis) {
        map.set(e.emoji, e);
        // A frequently used toned hand is named after its emoji too.
        for (const skin of e.skins ?? []) map.set(skin, e);
      }
    }
    return map;
  }, [groups]);

  const sections = useMemo(() => {
    if (!groups) return [];
    const list = groups.map((g) => ({
      id: g.id,
      label: g.label,
      emojis: g.emojis.map((item) => ({ emoji: inSkinTone(item, tone), label: item.label })),
    }));
    const used = frequent.map((emoji) => ({ emoji, label: itemOf.get(emoji)?.label ?? emoji }));
    return used.length > 0
      ? [{ id: FREQUENT_ID, label: "Frequently Used", emojis: used }, ...list]
      : list;
  }, [groups, frequent, itemOf, tone]);
  const current = active ?? sections[0]?.id ?? null;

  const pick = (emoji: string) => {
    countEmoji(emoji);
    onSelect(emoji);
  };
  const jump = (id: number) => {
    setQuery("");
    setActive(id);
    // After the sections are back on screen (a search hides them).
    requestAnimationFrame(() => {
      scroller.current
        ?.querySelector<HTMLElement>(`[data-emoji-section="${id}"]`)
        ?.scrollIntoView({ block: "start" });
    });
  };
  /** The tab follows what's being read: the last section whose title passed the top. */
  const onScroll = () => {
    const box = scroller.current;
    if (!box || query) return;
    const top = box.getBoundingClientRect().top;
    let reading: number | null = null;
    for (const el of box.querySelectorAll<HTMLElement>("[data-emoji-section]")) {
      if (el.getBoundingClientRect().top - top <= 12) reading = Number(el.dataset.emojiSection);
    }
    if (reading !== null && reading !== current) setActive(reading);
  };

  return (
    <div
      className="flex h-[26rem] max-h-[70vh] w-[23rem] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl"
      data-emoji-picker
    >
      <div
        className="flex items-stretch border-b border-line px-1"
        role="tablist"
        aria-label="Sections"
      >
        {sections.map((section) => {
          const Icon = SECTION_ICONS[section.id] ?? Smile;
          const selected = !query && current === section.id;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={section.label}
              title={section.label}
              onClick={() => jump(section.id)}
              className={`-mb-px flex h-10 min-w-0 flex-1 items-center justify-center border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                selected
                  ? "border-primary text-ink"
                  : "border-transparent text-ink-secondary hover:text-ink"
              }`}
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="px-3 pb-1 pt-3">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
          <SearchIcon className="shrink-0 text-ink-secondary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) pick(inSkinTone(results[0], tone));
            }}
            placeholder="Search all emoji"
            aria-label="Search emoji"
            className="w-full bg-transparent py-2 text-sm text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
      </div>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!groups && !failed && <p className="p-2 text-sm text-ink-secondary">Loading emoji…</p>}
        {failed && <p className="p-2 text-sm text-ink">Couldn't load emoji.</p>}

        {groups && query && (
          <section>
            <h3 className="sticky top-0 bg-surface-raised py-2 text-[13px] font-bold text-ink">
              Search results
            </h3>
            <div className="grid grid-cols-9 gap-0.5">
              {results.map((item) => (
                <EmojiButton
                  key={item.emoji}
                  emoji={inSkinTone(item, tone)}
                  label={item.label}
                  onPick={() => pick(inSkinTone(item, tone))}
                  onHover={setHovered}
                />
              ))}
            </div>
            {results.length === 0 && (
              <p className="p-2 text-sm text-ink-secondary">No emoji found for “{query}”.</p>
            )}
          </section>
        )}

        {groups &&
          !query &&
          sections.map((section) => (
            <section key={section.id} data-emoji-section={section.id} className="scroll-mt-0">
              <h3 className="sticky top-0 z-10 bg-surface-raised py-2 text-[13px] font-bold text-ink">
                {section.label}
              </h3>
              <div className="grid grid-cols-9 gap-0.5">
                {section.emojis.map((item) => (
                  <EmojiButton
                    key={item.emoji}
                    emoji={item.emoji}
                    label={item.label}
                    onPick={() => pick(item.emoji)}
                    onHover={setHovered}
                  />
                ))}
              </div>
            </section>
          ))}
      </div>

      <div className="flex h-12 items-center gap-2 border-t border-line px-3">
        {hovered ? (
          <>
            <span className="text-2xl leading-none" aria-hidden="true">
              {hovered.emoji}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
              {hovered.label}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-ink-secondary">Pick an emoji…</span>
        )}
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Skin tone">
          {(tones ? SKIN_SWATCHES.map((_, i) => i) : [tone]).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                if (!tones) return setTones(true);
                setTone(i);
                saveSkinTone(i);
                setTones(false);
              }}
              aria-label={tones ? `${SKIN_LABELS[i]} skin tone` : "Choose a skin tone"}
              aria-pressed={tones ? tone === i : undefined}
              title={tones ? SKIN_LABELS[i] : "Skin tone"}
              className={`flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none hover:bg-surface-hover ${
                tones && tone === i ? "bg-primary/20" : ""
              }`}
            >
              {SKIN_SWATCHES[i]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
