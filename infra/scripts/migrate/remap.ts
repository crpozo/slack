import { dmChannelId, dmMembers } from "@mindfultech/shared";

/**
 * Rewrites user ids (Cognito `sub`s) inside DynamoDB items when moving data to
 * another user pool, where everyone gets a new `sub`. Only whole values are
 * touched — never substrings of free text:
 *   - a string equal to an old id                → the new id
 *   - `MEMBER#<old>` (board membership sort key)  → `MEMBER#<new>`
 *   - a DM channel id `dm_<a>_<b>`                → rebuilt from the new ids (re-sorted)
 *   - `attachments/dm_<a>_<b>/…` (S3 key of a DM) → the same file under the new DM id
 * Arrays, plain objects and Sets (DynamoDB string sets: board members, reactions)
 * are walked recursively. Ids missing from `idMap` are left as they are.
 */
export interface Remapper {
  /** A single string (also used for S3 keys). */
  string: (value: string) => string;
  /** Any DynamoDB item value, recursively; returns a new value, never mutates. */
  value: <T>(value: T) => T;
}

const MEMBER_PREFIX = "MEMBER#";
const ATTACHMENTS_PREFIX = "attachments/";

export function createRemapper(idMap: ReadonlyMap<string, string>): Remapper {
  const id = (value: string) => idMap.get(value) ?? value;

  const dm = (channelId: string): string | null => {
    const members = dmMembers(channelId);
    return members ? dmChannelId(id(members[0]), id(members[1])) : null;
  };

  const string = (value: string): string => {
    if (idMap.has(value)) return id(value);
    if (value.startsWith(MEMBER_PREFIX))
      return MEMBER_PREFIX + id(value.slice(MEMBER_PREFIX.length));
    const channel = dm(value);
    if (channel) return channel;
    if (value.startsWith(ATTACHMENTS_PREFIX)) {
      const rest = value.slice(ATTACHMENTS_PREFIX.length);
      const slash = rest.indexOf("/");
      const owner = slash === -1 ? null : dm(rest.slice(0, slash));
      if (owner) return ATTACHMENTS_PREFIX + owner + rest.slice(slash);
    }
    return value;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return string(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Set) return new Set([...value].map(walk));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value; // numbers, booleans, null, binary
  };

  return { string, value: <T>(value: T) => walk(value) as T };
}
