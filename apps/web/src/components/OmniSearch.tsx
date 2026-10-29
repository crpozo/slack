import type { SearchResult } from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { chat } from "../lib/chat";
import type { MessageSearchState } from "../lib/messageSearch";
import { tasksApiConfigured } from "../lib/tasksApi";
import { ChannelIcon } from "./ChannelIcon";
import { SearchIcon } from "./icons";
import { MessageRow, shownResults, useMessageSearch } from "./MessageSearchResults";
import { useModalDialog } from "./Modal";
import { useSwitcherItems, type Item } from "./QuickSwitcher";
import { SEARCH_SHORTCUT } from "./Sidebar";

/** Conversations shown above the messages while a search is typed. */
const MAX_CONVERSATIONS = 5;

type Entry =
  | { kind: "conversation"; key: string; item: Item }
  | { kind: "message"; key: string; result: SearchResult };

/**
 * The omni-search palette (Phase 42), on Ctrl/Cmd+K and the sidebar's search
 * button: the conversations whose name matches (instant, as the quick
 * switcher was) and the messages that contain what's typed (`GET /search`,
 * sent after a 300 ms pause). Arrow keys move through both lists, Enter
 * opens: a conversation, or a message's conversation scrolled to it and
 * highlighted (a reply opens its thread).
 */
export function OmniSearch({ onClose }: Readonly<{ onClose: () => void }>) {
  const dialog = useModalDialog(onClose);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const canSearch = tasksApiConfigured();

  const [search, searcher] = useMessageSearch();

  const conversations = useSwitcherItems(query, onClose);
  const { results, truncated } = useMemo(() => shownResults(search), [search]);

  const entries = useMemo<Entry[]>(
    () => [
      ...conversations
        .slice(0, query.trim() ? MAX_CONVERSATIONS : undefined)
        .map((item): Entry => ({ kind: "conversation", key: `c:${item.key}`, item })),
      ...results.map((result): Entry => ({
        kind: "message",
        key: `m:${result.channelId}:${result.sk}`,
        result,
      })),
    ],
    [conversations, results, query],
  );
  const active = Math.min(index, Math.max(entries.length - 1, 0));

  // Keep the highlighted row in view while the arrows move through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-entry-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function open(entry: Entry | undefined) {
    if (!entry) return;
    if (entry.kind === "conversation") return entry.item.go();
    const { channelId, sk, parentSk } = entry.result;
    navigate(`/app/${channelId}`);
    chat.jumpTo({ channelId, sk, parentSk });
    onClose();
  }

  function handleKey(e: KeyboardEvent) {
    // Esc is handled by the native <dialog>.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((active + 1) % Math.max(entries.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((active - 1 + entries.length) % Math.max(entries.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(entries[active]);
    }
  }

  const firstMessage = entries.findIndex((e) => e.kind === "message");
  const typed = query.trim().length > 0;

  return (
    <dialog
      ref={dialog}
      aria-label="Search"
      className="mt-[12vh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl border border-white/10 p-0 text-ink shadow-[0_24px_64px_-12px_rgb(0_0_0/0.6)] glass-strong backdrop:bg-scrim/40 backdrop:backdrop-blur-sm"
      data-omni-search
    >
      <div className="flex items-center gap-3 border-b border-white/10 px-4">
        <SearchIcon className="shrink-0 text-lg text-primary" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            if (canSearch) searcher.update(e.target.value);
          }}
          onKeyDown={handleKey}
          placeholder="Search messages, channels and people…"
          aria-label="Search messages, channels and people"
          aria-controls="omni-search-results"
          aria-activedescendant={entries[active] ? `omni-${active}` : undefined}
          className="w-full bg-transparent py-4 text-base text-ink placeholder:text-ink-secondary focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        {search.status === "loading" && (
          <span
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
            role="status"
            aria-label="Searching"
            data-searching
          />
        )}
        <kbd className="hidden shrink-0 rounded-md border border-white/15 px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary sm:block">
          Esc
        </kbd>
      </div>

      <ul
        ref={listRef}
        id="omni-search-results"
        role="listbox"
        aria-label="Results"
        className="max-h-[min(60vh,32rem)] overflow-y-auto p-2"
      >
        {conversations.length > 0 && (
          <SectionTitle>{typed ? "Conversations" : "Jump to"}</SectionTitle>
        )}
        {entries.map((entry, i) => (
          <li
            key={entry.key}
            id={`omni-${i}`}
            role="option"
            aria-selected={i === active}
            data-entry-index={i}
          >
            {i === firstMessage && (
              <SectionTitle>
                Messages
                {truncated && (
                  <span className="ml-2 normal-case tracking-normal text-ink-secondary/70">
                    newest matches
                  </span>
                )}
              </SectionTitle>
            )}
            <button
              type="button"
              onMouseMove={() => i !== active && setIndex(i)}
              onClick={() => open(entry)}
              className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                i === active
                  ? "bg-primary/15 text-ink ring-1 ring-inset ring-primary/40"
                  : "text-ink-secondary hover:bg-white/[0.04]"
              }`}
              data-omni-entry={entry.kind}
            >
              {entry.kind === "conversation" ? (
                <ConversationRow item={entry.item} />
              ) : (
                <MessageRow result={entry.result} />
              )}
            </button>
          </li>
        ))}
        <Status
          state={search}
          typed={typed}
          canSearch={canSearch}
          hasEntries={entries.length > 0}
        />
      </ul>

      <div className="flex items-center gap-4 border-t border-white/10 px-4 py-2 text-[11px] text-ink-secondary">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
        </span>
        <span>
          <Kbd>↵</Kbd> to open
        </span>
        <span className="ml-auto hidden sm:inline">
          <Kbd>{SEARCH_SHORTCUT}</Kbd> anywhere
        </span>
      </div>
    </dialog>
  );
}

function SectionTitle({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-primary">
      {children}
    </p>
  );
}

function Kbd({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <kbd className="rounded border border-white/15 bg-white/[0.04] px-1 font-mono text-[10px]">
      {children}
    </kbd>
  );
}

function ConversationRow({ item }: Readonly<{ item: Item }>) {
  return (
    <>
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-ink-secondary">
        {item.kind === "channel" ? (
          <ChannelIcon channel={{ type: item.channelType ?? "public" }} className="" />
        ) : (
          "@"
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{item.label}</span>
      {item.hint && <span className="truncate text-xs text-ink-secondary">{item.hint}</span>}
    </>
  );
}

function Status({
  state,
  typed,
  canSearch,
  hasEntries,
}: Readonly<{
  state: MessageSearchState;
  typed: boolean;
  canSearch: boolean;
  hasEntries: boolean;
}>) {
  let text: string | null = null;
  if (!typed) text = canSearch ? "Type to search every message you can see." : null;
  else if (!canSearch) text = hasEntries ? null : "No conversations match.";
  else if (state.status === "idle")
    text = hasEntries ? null : "Type a longer word to search messages.";
  else if (state.status === "error") text = `Couldn't search messages: ${state.error}`;
  else if (state.status === "loading" && !state.previous) text = "Searching messages…";
  else if (state.status === "done" && state.response.results.length === 0) {
    text = `No messages match “${state.query}”.`;
  }
  if (!text) return null;
  return (
    <li
      className={`px-3 py-3 text-sm ${state.status === "error" ? "text-warning" : "text-ink-secondary"}`}
      role="status"
      data-omni-status
    >
      {text}
    </li>
  );
}
