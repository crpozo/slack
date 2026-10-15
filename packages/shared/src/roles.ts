// ---------------------------------------------------------------------------
// Roles (Phase 14). Cognito groups in the id token decide them, so they can't
// be forged by a client:
//   - "guest":  an external client invited to specific boards. Sees those
//               boards and nothing else (no channels, DMs, calls or settings).
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

/**
 * Server events a guest's connection may receive: their boards' changes and
 * nothing from the chat. Enforced at the single delivery choke point.
 */
export function guestMayReceive(eventType: string): boolean {
  return eventType.startsWith("board.");
}

/** WebSocket routes a guest may call: heartbeat, board file uploads, the board members' names. */
export const GUEST_ROUTES: ReadonlySet<string> = new Set(["ping", "presign", "user"]);
