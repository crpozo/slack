import { canManageVaultSecret, isDmChannel, type VaultSecret } from "@mindfultech/shared";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { channelLabel, displayName } from "../lib/channels";
import { tasksApiConfigured, TasksApiError } from "../lib/tasksApi";
import { filterSecrets } from "../lib/vault";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { useVault } from "../store/vault";
import {
  CopyIcon,
  LockIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  UsersIcon,
} from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { UnreadAlertsDot } from "./NotificationBell";
import { GLASS_CARD, OUTLINE_BUTTON, PRIMARY_BUTTON } from "./SkillsView";
import { ResetPinModal, SecretFormModal } from "./VaultModals";
import { VaultLockScreen } from "./VaultPin";
import { LaunchButton, PasswordControls } from "./VaultSecretCard";

const SMALL_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition hover:bg-white/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** "#project" or "@Ana" for a secret's channel, as the sidebar names it. */
function useChannelNamer(): (channelId: string) => string {
  const channels = useChat((s) => s.channels);
  const me = useChat((s) => s.me?.userId ?? "");
  const users = useChat((s) => s.users);
  const directory = useChat((s) => s.directory);
  return useCallback(
    (channelId: string) => {
      const channel = channels.find((c) => c.channelId === channelId);
      const label = channelLabel(
        channelId,
        channel,
        me,
        (id) => users[id]?.displayName ?? displayName(directory[id]),
      );
      return isDmChannel(channelId) ? `@${label}` : `#${label}`;
    },
    [channels, me, users, directory],
  );
}

/**
 * Vault (`/app/vault`, Phase 45): the team's passwords and API keys, each
 * filed under a channel (project). Phase 46: the lock screen comes first;
 * the PIN opens it for 15 minutes (Phase 52: across visits, and for Reveal
 * and Copy too, here and on chat cards); the list shows what the person may
 * see (admins all, staff theirs and those shared with them).
 */
export function VaultView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const { status, session, secrets, error, unlocked, lock, load, put, drop } = useVault();
  const showToast = useChat((s) => s.showToast);
  const me = useChat((s) => s.me);
  const configured = tasksApiConfigured();
  const channelName = useChannelNamer();
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("");
  const [form, setForm] = useState<"create" | { edit: VaultSecret } | null>(null);
  const [deleting, setDeleting] = useState<VaultSecret | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    document.title = "Vault · MindfulTech";
  }, []);
  // Phase 52: the Vault stays open for the session (the store locks it when it
  // runs out), so coming back needs no PIN: refresh the list instead. Opened
  // from a chat card, the session is there but the list isn't loaded yet.
  useEffect(() => {
    if (useVault.getState().openToken()) void load();
  }, [load]);

  const shown = useMemo(
    () => filterSecrets(secrets, query, channelId, channelName),
    [secrets, query, channelId, channelName],
  );
  const channelsWithSecrets = useMemo(
    () =>
      [...new Set(secrets.map((s) => s.channelId))]
        .map((id) => ({ id, label: channelName(id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [secrets, channelName],
  );
  const mayManage = (secret: VaultSecret) =>
    !!me && canManageVaultSecret(secret, me.userId, me.role);

  async function remove(secret: VaultSecret) {
    try {
      await vaultApi.remove(secret.secretId, session?.token ?? "");
      drop(secret.secretId);
      showToast(`${secret.name} deleted from the Vault`, "success");
    } catch (err) {
      showToast(
        err instanceof TasksApiError ? err.message : "Couldn't delete it. Try again.",
        "error",
      );
    } finally {
      setDeleting(null);
    }
  }

  const menu = onOpenSidebar && (
    <button
      type="button"
      onClick={onOpenSidebar}
      className="relative -ml-1 rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
      aria-label="Open menu"
    >
      <MenuIcon />
      <UnreadAlertsDot />
    </button>
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col bg-surface bg-[radial-gradient(900px_420px_at_15%_-10%,rgb(64_179_117/0.16),transparent_60%),radial-gradient(700px_400px_at_100%_10%,rgb(244_201_92/0.06),transparent_60%)]"
      data-vault-view
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-3">
                {menu}
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_4px_rgb(64_179_117/0.18),0_0_18px_rgb(64_179_117/0.6)]"
                  aria-hidden="true"
                />
                <h1 className="text-[32px] font-extrabold leading-tight tracking-tight text-ink">
                  Vault
                </h1>
              </div>
              <p className="text-sm text-ink-secondary">
                The team&apos;s passwords and API keys, encrypted with AWS KMS and shared per
                project
              </p>
            </div>
            {configured && session && (
              <div className="flex flex-wrap gap-2">
                {me?.role === "admin" && (
                  <button
                    type="button"
                    className={OUTLINE_BUTTON}
                    onClick={() => setResetting(true)}
                  >
                    <UsersIcon aria-hidden="true" /> Reset a PIN
                  </button>
                )}
                <button type="button" className={OUTLINE_BUTTON} onClick={lock} data-vault-lock-now>
                  <LockIcon aria-hidden="true" /> Lock
                </button>
                <button type="button" className={PRIMARY_BUTTON} onClick={() => setForm("create")}>
                  <PlusIcon aria-hidden="true" /> Create Secret
                </button>
              </div>
            )}
          </header>

          {!configured ? (
            <Notice>The Vault isn&apos;t set up on this deployment.</Notice>
          ) : status === "locked" || !session ? (
            <VaultLockScreen onUnlocked={(s) => void unlocked(s)} />
          ) : (
            <>
              <div className={`${GLASS_CARD} flex flex-col gap-3 p-3 sm:flex-row sm:items-center`}>
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 focus-within:border-primary/60">
                  <SearchIcon className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, username, website or channel…"
                    aria-label="Search the Vault"
                    className="h-10 w-full bg-transparent text-sm text-ink placeholder:text-ink-secondary focus:outline-none"
                  />
                </label>
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  aria-label="Filter by project"
                  className="h-10 rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-ink focus:border-primary/60 focus:outline-none sm:w-56"
                >
                  <option value="">All projects</option>
                  {channelsWithSecrets.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              {error && status === "ready" && (
                <p className="text-sm text-warning" role="status">
                  {error}
                </p>
              )}

              {status === "error" ? (
                <Notice>
                  {error}{" "}
                  <button
                    type="button"
                    className="font-semibold text-primary"
                    onClick={() => void load()}
                  >
                    Retry
                  </button>
                </Notice>
              ) : status !== "ready" ? (
                <div
                  className={`${GLASS_CARD} h-64 animate-pulse`}
                  aria-busy="true"
                  aria-label="Loading the Vault"
                />
              ) : shown.length === 0 ? (
                <Notice>
                  {secrets.length === 0 ? (
                    <>
                      No secrets yet. Create one, or type{" "}
                      <code className="rounded bg-white/10 px-1 font-mono text-ink">
                        /secret Title Password
                      </code>{" "}
                      in a channel.
                    </>
                  ) : (
                    "No secret matches the search."
                  )}
                </Notice>
              ) : (
                <div className={`${GLASS_CARD} overflow-hidden`}>
                  <table className="w-full border-collapse text-left text-sm" data-vault-table>
                    <thead className="hidden bg-white/[0.04] text-[11px] uppercase tracking-wide text-ink-secondary md:table-header-group">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Name</th>
                        <th className="px-4 py-3 font-semibold">Project</th>
                        <th className="px-4 py-3 font-semibold">Username</th>
                        <th className="w-[300px] px-4 py-3 font-semibold">Password</th>
                        <th className="px-2 py-3 font-semibold">Link</th>
                        <th className="w-20 px-2 py-3">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((secret) => (
                        <SecretRow
                          key={secret.secretId}
                          secret={secret}
                          channel={channelName(secret.channelId)}
                          canManage={mayManage(secret)}
                          sharedWith={secret.allowedUserIds.length}
                          onEdit={() => setForm({ edit: secret })}
                          onDelete={() => setDeleting(secret)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {form && (
        <SecretFormModal
          editing={typeof form === "object" ? form.edit : undefined}
          session={session?.token}
          onClose={() => setForm(null)}
          onSaved={(secret) => {
            put(secret);
            setForm(null);
          }}
        />
      )}
      {resetting && <ResetPinModal onClose={() => setResetting(false)} />}
      {deleting && (
        <Modal
          title="Delete secret"
          onClose={() => setDeleting(null)}
          width="sm"
          footer={
            <>
              <SecondaryButton onClick={() => setDeleting(null)}>Cancel</SecondaryButton>
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-error px-4 text-[13px] font-semibold text-white hover:opacity-90"
                onClick={() => void remove(deleting)}
                data-vault-confirm-delete
              >
                <TrashIcon aria-hidden="true" /> Delete
              </button>
            </>
          }
        >
          <p className="text-sm text-ink">
            Delete <strong>{deleting.name}</strong> from the Vault? Nobody will be able to reveal it
            again, including from cards in the chat.
          </p>
        </Modal>
      )}
    </div>
  );
}

function SecretRow({
  secret,
  channel,
  canManage,
  sharedWith,
  onEdit,
  onDelete,
}: Readonly<{
  secret: VaultSecret;
  channel: string;
  canManage: boolean;
  sharedWith: number;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const showToast = useChat((s) => s.showToast);
  return (
    <tr
      className="flex flex-col gap-2 border-t border-white/[0.06] px-4 py-4 first:border-t-0 md:table-row md:px-0 md:py-0"
      data-vault-row={secret.secretId}
    >
      <td className="md:px-4 md:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 text-primary"
            aria-hidden="true"
          >
            <LockIcon />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-ink">{secret.name}</span>
            <span className="text-xs text-ink-secondary">
              {secret.createdByName ?? ""}
              {` · ${sharedWith === 0 ? "only them" : `+${sharedWith} ${sharedWith === 1 ? "person" : "people"}`}`}
            </span>
          </div>
        </div>
      </td>
      <td className="md:px-4 md:py-3">
        <span className="inline-flex max-w-full truncate rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-ink-secondary">
          {channel}
        </span>
      </td>
      <td className="min-w-0 md:px-4 md:py-3">
        {secret.username ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-[13px] text-ink/90">{secret.username}</span>
            <button
              type="button"
              className={SMALL_BUTTON}
              aria-label={`Copy the ${secret.name} username`}
              title="Copy username"
              onClick={() =>
                void navigator.clipboard?.writeText(secret.username!).then(
                  () => showToast("Copied the username", "success"),
                  () => showToast("Couldn't copy", "error"),
                )
              }
            >
              <CopyIcon />
            </button>
          </span>
        ) : (
          <span className="text-xs text-ink-secondary">—</span>
        )}
      </td>
      <td className="md:px-4 md:py-3">
        <PasswordControls secretId={secret.secretId} name={secret.name} />
      </td>
      <td className="md:px-2 md:py-3">
        {secret.website ? (
          <LaunchButton href={secret.website} name={secret.name} />
        ) : (
          <span className="hidden text-xs text-ink-secondary md:inline">—</span>
        )}
      </td>
      <td className="md:px-2 md:py-3">
        {canManage && (
          <span className="flex gap-0.5">
            <button
              type="button"
              className={SMALL_BUTTON}
              onClick={onEdit}
              aria-label={`Edit ${secret.name}`}
              title="Edit and share"
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className={`${SMALL_BUTTON} hover:text-error`}
              onClick={onDelete}
              aria-label={`Delete ${secret.name}`}
              title="Delete"
            >
              <TrashIcon />
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

function Notice({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      className={`${GLASS_CARD} px-6 py-10 text-center text-sm text-ink-secondary`}
      role="status"
    >
      {children}
    </div>
  );
}
