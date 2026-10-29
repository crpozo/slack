import type { SearchResult, SearchSnippet } from "@mindfultech/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { channelLabel, dmPeer } from "../lib/channels";
import { createMessageSearch, searchApi, type MessageSearchState } from "../lib/messageSearch";
import { fullDate, relativeTime } from "../lib/news";
import { selectName, useChat } from "../store";
import { ChannelIcon } from "./ChannelIcon";

/**
 * Message search (Phase 42) for a search box: its state, and `update(query)`
 * to call on every keystroke (debounced; see `createMessageSearch`).
 */
export function useMessageSearch() {
  const [state, setState] = useState<MessageSearchState>({ status: "idle" });
  const searcher = useMemo(() => createMessageSearch((q) => searchApi.search(q), setState), []);
  useEffect(() => () => searcher.dispose(), [searcher]);
  return [state, searcher] as const;
}

/** The answer to show: the newest, or the previous one while the next is on its way. */
export function shownResults(state: MessageSearchState) {
  const response =
    state.status === "done"
      ? state.response
      : state.status === "loading"
        ? state.previous
        : undefined;
  return { results: response?.results ?? [], truncated: response?.truncated ?? false };
}

/**
 * One found message: where (channel or person), who wrote it and when, and
 * its snippet with the matches marked. Shared by the palette and the phones'
 * Search tab.
 */
export function MessageRow({ result }: Readonly<{ result: SearchResult }>) {
  const me = useChat((s) => s.me?.userId ?? "");
  const channel = useChat((s) => s.channels.find((c) => c.channelId === result.channelId));
  const where = useChat((s) =>
    channelLabel(result.channelId, channel, me, (id) => selectName(s, id)),
  );
  const author = useChat((s) => selectName(s, result.userId));
  const isDm = dmPeer(result.channelId, me) !== null;
  return (
    <>
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-ink-secondary">
        {isDm ? "@" : <ChannelIcon channel={{ type: channel?.type ?? "public" }} className="" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className="truncate font-semibold text-ink">{where}</span>
          <span className="truncate text-ink-secondary">
            {author}
            {result.parentSk && " · in a thread"}
          </span>
          <span
            className="ml-auto shrink-0 font-mono text-[11px] text-ink-secondary/80"
            title={fullDate(new Date(result.createdAt).toISOString())}
          >
            {relativeTime(new Date(result.createdAt).toISOString())}
          </span>
        </span>
        <Highlighted snippet={result.snippet} />
      </span>
    </>
  );
}

/** The snippet with its matches marked in the brand green (text only, never HTML). */
function Highlighted({ snippet }: Readonly<{ snippet: SearchSnippet }>) {
  const parts: ReactNode[] = [];
  let at = 0;
  snippet.highlights.forEach(([start, end], i) => {
    if (start < at) return;
    if (start > at) parts.push(snippet.text.slice(at, start));
    parts.push(
      <mark key={i} className="rounded bg-primary/25 px-0.5 font-semibold text-[#8fe0b0]">
        {snippet.text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < snippet.text.length) parts.push(snippet.text.slice(at));
  return <span className="line-clamp-2 text-sm leading-snug text-ink/85">{parts}</span>;
}
