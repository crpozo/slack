// ---------------------------------------------------------------------------
// Roles (Phase 14). Cognito groups in the id token decide them, so they can't
// be forged by a client:
//   - "guest":  an external (a client) invited to specific boards and, since
//               Phase 55, private channels, and (Phase 59) the calls of those
//               channels. Sees those and nothing else (no public channels, DMs,
//               DM calls, calendar, Vault or settings).
//   - "admin":  a team member who may also manage any channel (rename).
//   - "member": everyone else (the default; no group needed).
// ---------------------------------------------------------------------------

export const ROLES = ["member", "admin", "guest"] as const;
export type Role = (typeof ROLES)[number];

export const GUEST_GROUP = "guests";
export const ADMIN_GROUP = "admins";

/**
 * The role for a token's `cognito:groups` claim. Accepts the id token's array
 * and the HTTP API JWT authorizer's flattened form (`"[guests admins]"`).
 * Guest wins over admin: a misconfigured account gets less access, not more.
 */
export function roleFromGroups(groups: unknown): Role {
  const list = Array.isArray(groups)
    ? groups.map(String)
    : typeof groups === "string"
      ? groups.replace(/^\[|\]$/g, "").split(/[\s,]+/)
      : [];
  if (list.includes(GUEST_GROUP)) return "guest";
  if (list.includes(ADMIN_GROUP)) return "admin";
  return "member";
}

export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

/** What two people in a call exchange to connect (offers, answers, ICE, restarts). */
const CALL_MEDIA_EVENTS = ["call.offer", "call.answer", "call.ice_candidate", "call.renegotiate"];

/**
 * Chat events a guest's connection may receive (Phase 55): those of a
 * conversation. Each is only ever sent to the conversation's audience, which
 * for a guest is the private channels they're in (`canSeeChannel`); presence,
 * profiles, calls and the calendar never reach them.
 */
const GUEST_CHAT_EVENTS: ReadonlySet<string> = new Set([
  "channel.list",
  "channel.updated",
  "channel.deleted",
  "channel.read",
  "message.new",
  "message.updated",
  "message.deleted",
  "message.reaction",
  "message.thread_updated",
  "message.pinned",
  "user.typing",
  // Phase 59: the calls of the private channels they're in (rooms only: guests
  // have no DMs, so DM ringing never reaches them).
  "call.room",
  "call.rooms",
  // Phase 60: their channel's time log changed (they then read their own entries).
  "time.updated",
  ...CALL_MEDIA_EVENTS,
]);

/**
 * Server events a guest's connection may receive: their boards' changes and
 * their channels' messages. Enforced at the single delivery choke point.
 */
export function guestMayReceive(eventType: string): boolean {
  return eventType.startsWith("board.") || GUEST_CHAT_EVENTS.has(eventType);
}

/**
 * WebSocket routes a guest may call: heartbeat, file uploads, the names they
 * may see and, since Phase 55, writing in the private channels they're in
 * (every one of these checks the channel with `canSeeChannel`), and since
 * Phase 59 their channels' calls. Never DM calls, pins or anything else.
 */
export const GUEST_ROUTES: ReadonlySet<string> = new Set([
  "ping",
  "presign",
  "user",
  "channel",
  "message",
  "history",
  "typing",
  "react",
  "read",
  "edit",
  // Phase 59: the calls of their private channels (the handler refuses DM calls,
  // links and letting externals in).
  "call",
]);

// ---------------------------------------------------------------------------
// Externals (Phase 59): someone who opened a call link, with no account. Their
// connection is tied to that one call: it may knock, join once let in, and
// exchange the signals of the call, and nothing else. They never get a
// message, a channel, a name from the directory or anyone's presence.
// ---------------------------------------------------------------------------

/** WebSocket routes an external's connection may use. */
export const EXTERNAL_ROUTES: ReadonlySet<string> = new Set(["ping", "call"]);

const EXTERNAL_EVENTS: ReadonlySet<string> = new Set([
  "call.room",
  "call.lobby",
  ...CALL_MEDIA_EVENTS,
]);

/** Server events an external's connection may receive: their call's, nothing else. */
export function externalMayReceive(eventType: string): boolean {
  return EXTERNAL_EVENTS.has(eventType);
}
