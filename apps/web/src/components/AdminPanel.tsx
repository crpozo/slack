import {
  MAX_DISPLAY_NAME_LENGTH,
  ROLE_LABELS,
  TEAM_ROLES,
  type AccountStatus,
  type TeamMember,
  type TeamRole,
} from "@mindfultech/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { chat } from "../lib/chat";
import { teamApi } from "../lib/teamApi";
import { useChat } from "../store";
import { Avatar } from "./Avatar";
import { Modal, SecondaryButton } from "./Modal";

const STATUS: Record<AccountStatus, { label: string; className: string }> = {
  invited: { label: "Invited", className: "bg-warning/15 text-warning" },
  active: { label: "Active", className: "bg-success/15 text-success" },
  disabled: { label: "Disabled", className: "bg-surface-hover text-ink-secondary" },
};

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/**
 * Phase 62: Settings → Team, for admins. Invite someone by email as Staff or
 * Admin (Cognito emails them a temporary password; they show up in everyone's
 * directory at once), see everyone's role and status, and move people between
 * Staff and Admin. Guests come from channel invites, not from here.
 */
export function AdminPanel({ onClose }: Readonly<{ onClose: () => void }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setMembers(await teamApi.list());
    } catch (err) {
      setLoadError(errorText(err, "Couldn't load the team."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    try {
      const member = await teamApi.invite({
        email: email.trim(),
        ...(name.trim() && { displayName: name.trim() }),
        role,
      });
      setMembers((list) => [member, ...(list ?? []).filter((m) => m.userId !== member.userId)]);
      setEmail("");
      setName("");
      setRole("member");
      showToast(`Invitation sent to ${member.email}.`, "success");
      // They're in the directory now: everyone's DM list can show them.
      chat.refreshUsers();
    } catch (err) {
      setInviteError(errorText(err, "Couldn't send the invitation."));
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(member: TeamMember, next: TeamRole) {
    if (member.role === next) return;
    setChanging(member.userId);
    try {
      const updated = await teamApi.setRole(member.userId, next);
      setMembers((list) => (list ?? []).map((m) => (m.userId === updated.userId ? updated : m)));
      showToast(`${updated.displayName} is now ${ROLE_LABELS[next]}.`, "success");
      chat.refreshUsers();
    } catch (err) {
      showToast(errorText(err, "Couldn't change the role."), "error");
    } finally {
      setChanging(null);
    }
  }

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <Modal
      title="Team"
      onClose={onClose}
      width="lg"
      footer={<SecondaryButton onClick={onClose}>Close</SecondaryButton>}
    >
      <div className="space-y-6" data-admin-panel>
        <form onSubmit={invite} className="space-y-3" aria-label="Invite to the team">
          <h3 className="text-sm font-semibold text-ink">Invite someone</h3>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              className="input"
              type="email"
              required
              placeholder="name@company.com"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
            <input
              className="input"
              placeholder="Name (optional)"
              aria-label="Name"
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              className="input"
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as TeamRole)}
            >
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary" disabled={inviting || !validEmail}>
              {inviting ? "Sending…" : "Send invitation"}
            </button>
            <p className="text-xs text-ink-secondary">
              They get an email with a temporary password and set their own on first sign-in.
            </p>
          </div>
          {inviteError && (
            <p
              role="alert"
              className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
            >
              {inviteError}
            </p>
          )}
        </form>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">
            Everyone{members ? ` (${members.length})` : ""}
          </h3>
          {loadError && (
            <p role="alert" className="text-sm text-error">
              {loadError}{" "}
              <button type="button" className="underline" onClick={() => void load()}>
                Try again
              </button>
            </p>
          )}
          {!members && !loadError && (
            <p className="text-sm text-ink-secondary" aria-live="polite">
              Loading…
            </p>
          )}
          <ul className="divide-y divide-line rounded-lg border border-line">
            {members?.map((m) => {
              const self = m.userId === me?.userId;
              return (
                <li
                  key={m.userId}
                  className="flex items-center gap-3 px-3 py-2"
                  data-member={m.userId}
                >
                  <Avatar name={m.displayName || m.email} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {m.displayName}
                      {self && <span className="text-ink-secondary"> (you)</span>}
                    </p>
                    <p className="truncate text-xs text-ink-secondary">{m.email}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS[m.status].className}`}
                  >
                    {STATUS[m.status].label}
                  </span>
                  {m.role === "guest" || self ? (
                    <span className="w-24 shrink-0 text-right text-xs text-ink-secondary">
                      {ROLE_LABELS[m.role]}
                    </span>
                  ) : (
                    <select
                      className="input w-24 shrink-0 py-1 text-xs"
                      aria-label={`Role of ${m.displayName}`}
                      value={m.role}
                      disabled={changing === m.userId}
                      onChange={(e) => void changeRole(m, e.target.value as TeamRole)}
                    >
                      {TEAM_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink-secondary">
            A new role applies when that person next signs in, or within the hour.
          </p>
        </section>
      </div>
    </Modal>
  );
}
