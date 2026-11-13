import type { InviteTeamMemberInput, TeamList, TeamMember, TeamRole } from "@mindfultech/shared";
import { request } from "./tasksApi";

/** Phase 62: the team panel (admins only), on the same HTTP API and auth as the Task Manager. */
export const teamApi = {
  list: () => request<TeamList>("GET", "/admin/users").then((r) => r.members),
  invite: (input: InviteTeamMemberInput) =>
    request<{ member: TeamMember }>("POST", "/admin/users", input).then((r) => r.member),
  setRole: (userId: string, role: TeamRole) =>
    request<{ member: TeamMember }>("PUT", `/admin/users/${encodeURIComponent(userId)}/role`, {
      role,
    }).then((r) => r.member),
};
