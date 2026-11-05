import {
  generatePassword,
  isChannelMember,
  MAX_VAULT_NAME,
  MAX_VAULT_PASSWORD,
  MAX_VAULT_USERNAME,
  MAX_VAULT_WEBSITE,
  normalizeWebsite,
  type UserProfile,
  type VaultSecret,
} from "@mindfultech/shared";
import { useMemo, useState, type FormEvent } from "react";
import { channelLabel, displayName } from "../lib/channels";
import { TasksApiError } from "../lib/tasksApi";
import { vaultApi } from "../lib/vaultApi";
import { useShallow } from "zustand/react/shallow";
import { useChat, useNameOf } from "../store";
import { EyeIcon, EyeOffIcon, LockIcon, WandIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { PRIMARY_BUTTON } from "./SkillsView";
import { UserPicker } from "./UserPicker";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-ink placeholder:text-ink-secondary focus:border-primary/60 focus:outline-none";
const LABEL = "flex flex-col gap-1.5 text-sm font-medium text-ink";

/** Channels the caller can save into (theirs, not archived), labelled as in the sidebar. */
export function useVaultChannels(): Array<{ channelId: string; label: string }> {
  const channels = useChat((s) => s.channels);
  const me = useChat((s) => s.me?.userId ?? "");
  const users = useChat((s) => s.users);
  const directory = useChat((s) => s.directory);
  return useMemo(() => {
    const nameOf = (id: string) => users[id]?.displayName ?? displayName(directory[id]);
    return channels
      .filter((c) => !c.archived && isChannelMember(c, me))
      .map((c) => {
        const label = channelLabel(c.channelId, c, me, nameOf);
        return { channelId: c.channelId, label: c.type === "dm" ? `@${label}` : `#${label}` };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [channels, me, users, directory]);
}

/** Teammates a secret can be shared with: the directory without guests, by name. */
function useTeam(exclude: string): UserProfile[] {
  const users = useChat(useShallow((s) => Object.values(s.users)));
  return useMemo(
    () =>
      users
        .filter((u) => u.userId !== exclude && u.role !== "guest")
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users, exclude],
  );
}

/**
 * "Create Secret" and "Edit Secret": title, URL, username, password (typed or
 * generated; when editing, only a new one), the project/channel it's filed
 * under, and who may see it (Phase 46): the people picked here, its saver and
 * the admins. The password goes straight to the server, which encrypts it
 * with KMS; nothing is kept here.
 */
export function SecretFormModal({
  editing,
  session,
  defaultChannelId,
  onClose,
  onSaved,
}: Readonly<{
  /** Edit this secret (needs the unlocked Vault's `session`). */
  editing?: VaultSecret;
  session?: string;
  defaultChannelId?: string;
  onClose: () => void;
  onSaved: (secret: VaultSecret) => void;
}>) {
  const showToast = useChat((s) => s.showToast);
  const me = useChat((s) => s.me?.userId ?? "");
  const allChannels = useChat((s) => s.channels);
  const mine = useVaultChannels();
  const owner = editing?.createdBy ?? me;
  const team = useTeam(owner);
  const nameOf = useNameOf();
  // An admin editing someone else's secret keeps its channel even if they're not in it.
  const channels = useMemo(
    () =>
      editing && !mine.some((c) => c.channelId === editing.channelId)
        ? [{ channelId: editing.channelId, label: "(its current channel)" }, ...mine]
        : mine,
    [editing, mine],
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [website, setWebsite] = useState(editing?.website ?? "");
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [channelId, setChannelId] = useState(
    editing?.channelId ??
      (channels.some((c) => c.channelId === defaultChannelId)
        ? defaultChannelId!
        : (channels[0]?.channelId ?? "")),
  );
  const [allowed, setAllowed] = useState<string[]>(editing?.allowedUserIds ?? []);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const websiteInvalid = website.trim() !== "" && !normalizeWebsite(website);
  const needsPassword = !editing;
  const canSave =
    !!name.trim() &&
    (!needsPassword || !!password.trim()) &&
    !!channelId &&
    !websiteInvalid &&
    !busy;
  const channel = allChannels.find((c) => c.channelId === channelId);
  const channelMembers = useMemo(() => {
    if (!channel) return [];
    const ids = channel.type === "public" ? team.map((u) => u.userId) : (channel.members ?? []);
    return ids.filter((id) => id !== owner && team.some((u) => u.userId === id));
  }, [channel, team, owner]);

  function generate() {
    setPassword(generatePassword());
    setVisible(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const fields = {
      channelId,
      name: name.trim(),
      username: username.trim(),
      website: website.trim(),
      allowedUserIds: allowed,
    };
    try {
      if (editing) {
        const secret = await vaultApi.update(
          editing.secretId,
          { ...fields, ...(password && { password }) },
          session ?? "",
        );
        setPassword("");
        showToast(`${secret.name} updated`, "success");
        onSaved(secret);
        return;
      }
      const saved = await vaultApi.create({
        ...fields,
        password,
        ...(share && { share: true }),
      });
      setPassword("");
      showToast(
        share && !saved.shared
          ? `${saved.secret.name} saved, but the chat card couldn't be posted`
          : `${saved.secret.name} saved to the Vault`,
        share && !saved.shared ? "error" : "success",
      );
      onSaved(saved.secret);
    } catch (err) {
      setError(err instanceof TasksApiError || err instanceof Error ? err.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? "Edit Secret" : "Create Secret"}
      onClose={onClose}
      width="md"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="vault-secret-form"
            className={PRIMARY_BUTTON}
            disabled={!canSave}
            data-vault-save
          >
            <LockIcon aria-hidden="true" />
            {busy ? "Encrypting…" : editing ? "Save changes" : "Save secret"}
          </button>
        </>
      }
    >
      <form
        id="vault-secret-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => void submit(e)}
        autoComplete="off"
      >
        <label className={LABEL}>
          Title
          <input
            className={INPUT}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_VAULT_NAME}
            placeholder="AWS console (prod)"
            required
            autoFocus
            data-vault-name
          />
        </label>
        <label className={LABEL}>
          URL
          <input
            className={`${INPUT} ${websiteInvalid ? "border-error/70" : ""}`}
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            maxLength={MAX_VAULT_WEBSITE}
            placeholder="https://console.aws.amazon.com"
            inputMode="url"
            aria-invalid={websiteInvalid}
            data-vault-website
          />
          {websiteInvalid && (
            <span className="text-xs font-normal text-error">
              Use a web address like https://example.com
            </span>
          )}
        </label>
        <label className={LABEL}>
          Username
          <input
            className={INPUT}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={MAX_VAULT_USERNAME}
            placeholder="admin@mindfultech.ec"
            autoComplete="off"
            data-vault-username
          />
        </label>
        <div className={LABEL}>
          <span className="flex items-center justify-between gap-2">
            <label htmlFor="vault-password">{editing ? "New password" : "Password"}</label>
            <button
              type="button"
              onClick={generate}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              data-vault-generate
            >
              <WandIcon aria-hidden="true" /> Generate strong password
            </button>
          </span>
          <span className="flex items-center gap-2">
            <input
              id="vault-password"
              className={`${INPUT} font-mono`}
              type={visible ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={MAX_VAULT_PASSWORD}
              autoComplete="new-password"
              spellCheck={false}
              required={needsPassword}
              placeholder={editing ? "Leave empty to keep the current one" : undefined}
              data-vault-password
            />
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-ink-secondary hover:text-ink"
              aria-label={visible ? "Hide password" : "Show password"}
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </span>
        </div>
        <label className={LABEL}>
          Project / channel
          <select
            className={INPUT}
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            data-vault-channel
          >
            {channels.map((c) => (
              <option key={c.channelId} value={c.channelId}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className={LABEL} data-vault-access>
          <span className="flex items-center justify-between gap-2">
            <span>Who can see it</span>
            {channelMembers.length > 0 && (
              <button
                type="button"
                onClick={() => setAllowed([...new Set([...allowed, ...channelMembers])])}
                className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10"
                data-vault-add-channel
              >
                + Everyone in this channel
              </button>
            )}
          </span>
          <span className="text-xs font-normal text-ink-secondary">
            {owner === me ? "You" : nameOf(owner)} and admins always can. Pick the teammates who may
            reveal and copy it ({allowed.length} selected).
          </span>
          <UserPicker users={team} selected={allowed} onChange={setAllowed} />
        </div>
        {!editing && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Also post a 🔒 card in the channel
          </label>
        )}
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}
        <p className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-ink-secondary">
          <LockIcon className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          Encrypted with AWS KMS before it&apos;s stored. Revealing it asks for the Vault PIN, and
          every reveal is logged.
        </p>
      </form>
    </Modal>
  );
}

/** Admins (Phase 46): clear a teammate's forgotten PIN; they choose a new one next visit. */
export function ResetPinModal({ onClose }: Readonly<{ onClose: () => void }>) {
  const showToast = useChat((s) => s.showToast);
  const team = useTeam("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const person = team.find((u) => u.userId === picked[0]);

  async function reset() {
    if (!person) return;
    setBusy(true);
    try {
      await vaultApi.resetPin(person.userId);
      showToast(`${person.displayName}'s Vault PIN was reset`, "success");
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't reset it. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Reset a Vault PIN"
      onClose={onClose}
      width="sm"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={!person || busy}
            onClick={() => void reset()}
          >
            {busy ? "Resetting…" : person ? `Reset ${person.displayName}'s PIN` : "Reset PIN"}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-secondary">
        For someone who forgot theirs: they&apos;ll choose a new PIN the next time they open the
        Vault. Their secrets stay as they are.
      </p>
      <UserPicker users={team} selected={picked} onChange={setPicked} mode="single" />
    </Modal>
  );
}
