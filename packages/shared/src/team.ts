import { z } from "zod";
import { MAX_DISPLAY_NAME_LENGTH } from "./protocol";
import type { Role } from "./roles";

// ---------------------------------------------------------------------------
// Phase 62: the team, managed by admins (Settings → Team). Roles live in
// Cognito groups (signed into every token, so a client can't fake one) and
// are mirrored in `users.role`:
//   - "member": staff, the default (no group). Shown as "Staff".
//   - "admin":  the `admins` group. Manages the team and any channel.
//   - "guest":  the `guests` group. A client's account, created by a channel
//               invite by email, never from the team panel.
// ---------------------------------------------------------------------------

/** The roles an admin can give from the team panel. */
export const TEAM_ROLES = ["member", "admin"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** What each role is called in the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  member: "Staff",
  admin: "Admin",
  guest: "Guest",
};

/** `POST /admin/users`: invite someone to the team (Cognito emails them a temporary password). */
export const InviteTeamMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  /** How the team sees them until they change it; the email's local part when absent. */
  displayName: z
    .string()
    .trim()
    .max(MAX_DISPLAY_NAME_LENGTH)
    .refine((v) => !/\p{Cc}/u.test(v), "no control characters")
    .optional(),
  role: z.enum(TEAM_ROLES).default("member"),
});
export type InviteTeamMemberInput = z.input<typeof InviteTeamMemberSchema>;

/** `PUT /admin/users/{userId}/role`. */
export const SetTeamRoleSchema = z.object({ role: z.enum(TEAM_ROLES) });

/**
 * Where an account stands in Cognito: `invited` until they set their own
 * password (FORCE_CHANGE_PASSWORD), `active` once they have, `disabled` when
 * an admin turned the account off in Cognito.
 */
export type AccountStatus = "invited" | "active" | "disabled";

/** One account in the team panel. */
export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
  /** Epoch ms the account was created in Cognito. */
  createdAt: number;
}

/** `GET /admin/users`. */
export interface TeamList {
  members: TeamMember[];
}
