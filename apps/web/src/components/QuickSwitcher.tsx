import { dmChannelId } from "@mindfultech/shared";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { dmEntries } from "../lib/channels";
import { useChat } from "../store";
import { HashIcon, SearchIcon } from "./icons";
import { useModalDialog } from "./Modal";

export interface Item {
  key: string;
  label: string;
  kind: "channel" | "dm";
  /** Extra searchable text (the email for people). */
  hint?: string;
  go: () => void;
}

/**
 * Channels (archived ones labelled) and people matching `query`, each with a
 * `go` that opens it and then calls `onDone`. Shared by the palette and the
 * phones' Search tab.
 */
export function useSwitcherItems(query: string, onDone: () => void): Item[] {
  const navigate = useNavigate();
  const { me, channels, team, directory, users } = useChat(
    useShallow((s) => ({
      me: s.me,
      channels: s.channels,
      team: s.team,
      directory: s.directory,
      users: s.users,
    })),
  );

  return useMemo<Item[]>(() => {
    if (!me) return [];
    const go = (path: string) => () => {
      navigate(path);
      onDone();
    };
    const publicItems: Item[] = channels
      .filter((c) => c.type !== "dm")
      .map((c) => ({
        key: c.channelId,
        label: c.archived ? `${c.name} (archived)` : c.name,
        kind: "channel",
        go: go(`/app/${c.channelId}`),
      }));
    const dmItems: Item[] = dmEntries(
      team,
      channels,
      me,
      directory,
      (id) => dmChannelId(me.userId, id),
      users,
    )
      .filter((d) => d.userId)
      .map((d) => ({
        key: d.userId ?? d.email,
        label: d.name,
        hint: d.email,
        kind: "dm",
        go: () => {
          const id = chat.openDm(d.userId as string);
          if (id) go(`/app/${id}`)();
        },
      }));
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return [...publicItems, ...dmItems].filter((i) =>
      `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q),
    );
  }, [me, channels, team, directory, users, query, navigate, onDone]);
}

/** Ctrl/Cmd+K palette to jump between channels and DMs. */
export function QuickSwitcher({ onClose }: Readonly<{ onClose: () => void }>) {
  const dialog = useModalDialog(onClose);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const items = useSwitcherItems(query, onClose);

  const active = Math.min(index, Math.max(items.length - 1, 0));

  function handleKey(e: KeyboardEvent) {
    // Esc is handled by the native <dialog>.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((active + 1) % Math.max(items.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((active - 1 + items.length) % Math.max(items.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.go();
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Jump to a channel"
      className="mt-[15vh] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-scrim/40"
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <SearchIcon className="text-ink-secondary" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={handleKey}
          placeholder="Search channels or people…"
          className="w-full bg-transparent py-3 text-base text-ink sm:text-sm placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
      <ul className="max-h-72 overflow-y-auto p-1" role="listbox">
        {items.map((item, i) => (
          <li key={item.key} role="option" aria-selected={i === active}>
            <button
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={item.go}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                i === active ? "bg-primary/20 text-ink" : "text-ink-secondary"
              }`}
            >
              {item.kind === "channel" ? (
                <HashIcon />
              ) : (
                <span className="w-[1em] text-center">@</span>
              )}
              {item.label}
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="px-3 py-2 text-sm text-ink-secondary">No results</li>}
      </ul>
    </dialog>
  );
}
