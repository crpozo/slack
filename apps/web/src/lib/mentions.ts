import { mentionHandle, type UserProfile } from "@mindfultech/shared";
import { normalizeSearch } from "./emoji";

// ---------------------------------------------------------------------------
// @mentions (Phase 56): the composer suggests the people in the conversation
// as you type `@`, and messages show a mention highlighted (yours more so).
// A mention is plain text: `@` and the person's handle, which the server
// matches for notifications (`findMentions` / `mentionHandle`): the display
// name without spaces, or the email's local part.
// ---------------------------------------------------------------------------

/** What can follow `@` (as `findMentions` reads it). */
const HANDLE_CHARS = /^[\p{L}\p{N}._-]{0,64}$/u;
/** Before `@`: the start, or anything that can't be part of a word or an email. */
const BEFORE_AT = /[\p{L}\p{N}_.@-]/u;

/** The handle a mention of `user` writes: their display name, without spaces, lower case. */
export const handleOf = (user: Pick<UserProfile, "displayName">): string =>
  mentionHandle(user.displayName);

/** Every handle that mentions `user` (display name, and the email's local part). */
export function handlesOf(user: Pick<UserProfile, "displayName" | "email">): string[] {
  const local = (user.email.split("@")[0] ?? "").toLowerCase();
  return [...new Set([handleOf(user), local].filter(Boolean))];
}

/**
 * The mention being typed at `caret`: where its `@` is and what follows it
 * ("" right after the `@`); `null` when the caret isn't in one (an email
 * address, a word, a space after it).
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const query = before.slice(at + 1);
  if (!HANDLE_CHARS.test(query)) return null;
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && BEFORE_AT.test(prev)) return null;
  return { start: at, query };
}

/**
 * Who to suggest for `query`: names that start with it first, then names
 * that contain it (accents and case aside), at most `limit`.
 */
export function mentionCandidates<T extends Pick<UserProfile, "displayName" | "email">>(
  people: T[],
  query: string,
  limit = 6,
): T[] {
  const q = normalizeSearch(query);
  const scored = people
    .map((p) => {
      const names = [p.displayName, ...handlesOf(p)].map(normalizeSearch);
      const starts = names.some(
        (n) => n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q)),
      );
      const contains = starts || names.some((n) => n.includes(q));
      return { p, rank: starts ? 0 : contains ? 1 : 2 };
    })
    .filter((s) => s.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.p.displayName.localeCompare(b.p.displayName));
  return scored.slice(0, limit).map((s) => s.p);
}

/** `text` with the mention at `start…end` replaced by `@handle ` and where the caret goes. */
export function insertMention(
  text: string,
  start: number,
  end: number,
  handle: string,
): { text: string; caret: number } {
  const inserted = `@${handle} `;
  const rest = text.slice(end).replace(/^ /, "");
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}
