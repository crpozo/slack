import { dmChannelId } from "@mindfultech/shared";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { dmEntries } from "../lib/channels";
import { useChat } from "../store";
import { HashIcon, SearchIcon } from "./icons";

interface Item {
  key: string;
  label: string;
  kind: "channel" | "dm";
  go: () => void;
}

/** Ctrl/Cmd+K palette to jump between channels and DMs. */
export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const { me, channels, team, directory } = useChat(
    useShallow((s) => ({ me: s.me, channels: s.channels, team: s.team, directory: s.directory })),
  );

  const items = useMemo<Item[]>(() => {
    if (!me) return [];
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const publicItems: Item[] = channels
      .filter((c) => c.type === "public")
      .map((c) => ({
        key: c.channelId,
        label: c.name,
        kind: "channel",
        go: go(`/app/${c.channelId}`),
      }));
    const dmItems: Item[] = dmEntries(team, channels, me, directory, (id) =>
      dmChannelId(me.userId, id),
    )
      .filter((d) => d.userId)
      .map((d) => ({
        key: d.email,
        label: d.email,
        kind: "dm",
        go: () => {
          const id = chat.openDm(d.userId as string);
          if (id) go(`/app/${id}`)();
        },
      }));
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return [...publicItems, ...dmItems].filter((i) => i.label.toLowerCase().includes(q));
  }, [me, channels, team, directory, query, navigate, onClose]);

  const active = Math.min(index, Math.max(items.length - 1, 0));

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 px-4 pt-[15vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Ir a un canal"
        className="w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <SearchIcon className="text-ink-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={handleKey}
            placeholder="Buscar canal o persona…"
            className="w-full bg-transparent py-3 text-sm text-ink placeholder:text-ink-secondary focus:outline-none"
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
          {items.length === 0 && (
            <li className="px-3 py-2 text-sm text-ink-secondary">Sin resultados</li>
          )}
        </ul>
      </div>
    </div>
  );
}
