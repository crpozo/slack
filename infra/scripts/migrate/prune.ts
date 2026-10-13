import { dmMembers } from "@mindfultech/shared";

/** Every migrated table, loaded in memory (a small team: a few thousand rows at most). */
export type Item = Record<string, unknown>;
export interface Dataset {
  users: Item[];
  channels: Item[];
  messages: Item[];
  boards: Item[];
  tasks: Item[];
}

export interface PruneResult {
  data: Dataset;
  /** How many rows of each table were left out. */
  dropped: Record<keyof Dataset, number>;
  /** S3 keys / key prefixes that belong only to left-out data. */
  skipFile: (key: string) => boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const attachmentKeys = (item: Item): string[] =>
  Array.isArray(item.attachments)
    ? item.attachments.map((a) => str((a as Item | null)?.key)).filter(Boolean)
    : [];

/** `list` without the excluded ids, keeping its kind (array or string Set). */
function without(list: unknown, excluded: ReadonlySet<string>): unknown {
  if (list instanceof Set) return new Set([...list].filter((id) => !excluded.has(id)));
  if (Array.isArray(list)) return list.filter((id) => !excluded.has(id));
  return list;
}

/** Reactions minus excluded users; emojis left with nobody disappear (DynamoDB has no empty sets). */
function pruneReactions(reactions: unknown, excluded: ReadonlySet<string>): unknown {
  if (!reactions || typeof reactions !== "object") return reactions;
  const entries = Object.entries(reactions as Record<string, unknown>)
    .map(([emoji, users]) => [emoji, without(users, excluded)] as const)
    .filter(([, users]) => (users instanceof Set ? users.size : (users as unknown[]).length) > 0);
  return Object.fromEntries(entries);
}

const size = (v: unknown) => (v instanceof Set ? v.size : Array.isArray(v) ? v.length : 0);

/**
 * Leaves out everything that only made sense with the excluded users (test
 * accounts deleted from the source pool):
 *   - their directory row;
 *   - DMs with them, with all their messages (call summaries included) and files;
 *   - private channels nobody else is in any more, with their messages;
 *   - their messages anywhere, and their files;
 *   - boards they own, with every task and file; tasks they created elsewhere;
 * and removes them from what stays: channel/board member lists, membership rows,
 * reactions, task assignments (→ unassigned). Channels they created stay (any
 * member can delete a channel whose creator no longer exists).
 */
export function pruneExcluded(data: Dataset, excluded: ReadonlySet<string>): PruneResult {
  const droppedChannels = new Set<string>();
  const droppedBoards = new Set<string>();
  const droppedFiles = new Set<string>();
  const dropped = { users: 0, channels: 0, messages: 0, boards: 0, tasks: 0 };
  const keep = <T>(table: keyof Dataset, ok: boolean, value: T): T[] => {
    if (!ok) dropped[table]++;
    return ok ? [value] : [];
  };

  if (excluded.size === 0) {
    return { data, dropped, skipFile: () => false };
  }

  const users = data.users.flatMap((u) => keep("users", !excluded.has(str(u.userId)), u));

  const channels = data.channels.flatMap((c) => {
    const id = str(c.channelId);
    const dm = dmMembers(id);
    const members = without(c.members, excluded);
    const orphanedPrivate = c.type === "private" && size(members) === 0;
    const ok = !(dm && dm.some((m) => excluded.has(m))) && !orphanedPrivate;
    if (!ok) droppedChannels.add(id);
    return keep("channels", ok, c.members === undefined ? c : { ...c, members });
  });

  const messages = data.messages.flatMap((m) => {
    const ok = !droppedChannels.has(str(m.channelId)) && !excluded.has(str(m.userId));
    if (!ok) attachmentKeys(m).forEach((k) => droppedFiles.add(k));
    const kept =
      m.reactions === undefined ? m : { ...m, reactions: pruneReactions(m.reactions, excluded) };
    return keep("messages", ok, kept);
  });

  for (const b of data.boards) {
    if (b.sk === "BOARD" && excluded.has(str(b.ownerId))) droppedBoards.add(str(b.boardId));
  }
  const boards = data.boards.flatMap((b) => {
    const ok =
      !droppedBoards.has(str(b.boardId)) &&
      !(str(b.sk).startsWith("MEMBER#") && excluded.has(str(b.userId)));
    return keep(
      "boards",
      ok,
      b.members === undefined ? b : { ...b, members: without(b.members, excluded) },
    );
  });

  const tasks = data.tasks.flatMap((t) => {
    const ok = !droppedBoards.has(str(t.boardId)) && !excluded.has(str(t.createdBy));
    if (!ok) attachmentKeys(t).forEach((k) => droppedFiles.add(k));
    const kept = excluded.has(str(t.assigneeId)) ? { ...t, assigneeId: null } : t;
    return keep("tasks", ok, kept);
  });

  const droppedPrefixes = [...droppedChannels, ...droppedBoards].map((id) => `attachments/${id}/`);
  return {
    data: { users, channels, messages, boards, tasks },
    dropped,
    skipFile: (key) => droppedFiles.has(key) || droppedPrefixes.some((p) => key.startsWith(p)),
  };
}
