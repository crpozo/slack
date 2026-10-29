import { dmChannelId } from "@mindfultech/shared";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { dmEntries } from "../lib/channels";
import { useChat } from "../store";

export interface Item {
  key: string;
  label: string;
  kind: "channel" | "dm";
  /** Channels: public or private (decides the icon). */
  channelType?: "public" | "private";
  /** Extra searchable text (the email for people). */
  hint?: string;
  go: () => void;
}

/**
 * Channels (archived ones labelled) and people matching `query`, each with a
 * `go` that opens it and then calls `onDone`. Shared by the omni-search
 * palette (Phase 42; it replaced the Ctrl/Cmd+K quick switcher) and the
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
        channelType: c.type === "private" ? "private" : "public",
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
