import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadEmojiGroups,
  loadRecentEmojis,
  rememberEmoji,
  searchEmojis,
  type EmojiGroup,
  type EmojiItem,
} from "../lib/emoji";
import { SearchIcon } from "./icons";

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

function EmojiButton({
  item,
  onPick,
}: Readonly<{
  item: Pick<EmojiItem, "emoji" | "label">;
  onPick: () => void;
}>) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={item.label}
      aria-label={item.label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      {item.emoji}
    </button>
  );
}

/** Searchable emoji grid (English names), with recents; the dataset loads on first open. */
export function EmojiPicker({ onSelect }: Readonly<EmojiPickerProps>) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [recent] = useState(loadRecentEmojis);
  const [activeGroup, setActiveGroup] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
  const labelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups ?? []) for (const e of g.emojis) map.set(e.emoji, e.label);
    return map;
  }, [groups]);

  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    onSelect(emoji);
  };
  const shownGroups = groups?.filter((g) => activeGroup === null || g.id === activeGroup) ?? [];

  return (
    <div className="flex h-80 w-80 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl glass-strong border border-white/10">
      <div className="border-b border-line p-2">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 focus-within:border-primary">
          <SearchIcon className="shrink-0 text-ink-secondary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) pick(results[0].emoji);
            }}
            placeholder="Search emoji (e.g. heart)"
            aria-label="Search emoji"
            className="w-full bg-transparent py-1.5 text-sm text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
      </div>

      {groups && !query && (
        <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1" role="tablist">
          {[
            { id: null, emoji: "🕘", label: "All" },
            ...groups.map((g) => ({ id: g.id, emoji: g.emojis[0]?.emoji ?? "", label: g.label })),
          ].map((tab) => (
            <button
              key={tab.id ?? "all"}
              type="button"
              role="tab"
              aria-selected={activeGroup === tab.id}
              title={tab.label}
              onClick={() => setActiveGroup(tab.id)}
              className={`rounded-md px-1.5 py-1 text-base ${
                activeGroup === tab.id ? "bg-primary/20" : "hover:bg-surface-hover"
              }`}
            >
              {tab.emoji}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {!groups && !failed && <p className="p-2 text-sm text-ink-secondary">Loading emoji…</p>}
        {failed && <p className="p-2 text-sm text-ink">Couldn't load emoji.</p>}

        {groups && query && (
          <div className="grid grid-cols-8 gap-0.5">
            {results.map((item) => (
              <EmojiButton key={item.emoji} item={item} onPick={() => pick(item.emoji)} />
            ))}
            {results.length === 0 && (
              <p className="col-span-8 p-2 text-sm text-ink-secondary">No results.</p>
            )}
          </div>
        )}

        {groups && !query && (
          <>
            {activeGroup === null && recent.length > 0 && (
              <section className="mb-2">
                <h3 className="px-1 pb-1 text-xs font-semibold text-ink-secondary">Recent</h3>
                <div className="grid grid-cols-8 gap-0.5">
                  {recent.map((emoji) => (
                    <EmojiButton
                      key={emoji}
                      item={{ emoji, label: labelOf.get(emoji) ?? emoji }}
                      onPick={() => pick(emoji)}
                    />
                  ))}
                </div>
              </section>
            )}
            {shownGroups.map((group) => (
              <section key={group.id} className="mb-2">
                <h3 className="px-1 pb-1 text-xs font-semibold text-ink-secondary">
                  {group.label}
                </h3>
                <div className="grid grid-cols-8 gap-0.5">
                  {group.emojis.map((item) => (
                    <EmojiButton key={item.emoji} item={item} onPick={() => pick(item.emoji)} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
