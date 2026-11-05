import {
  generatePassword,
  isChannelMember,
  MAX_VAULT_NAME,
  MAX_VAULT_PASSWORD,
  MAX_VAULT_USERNAME,
  MAX_VAULT_WEBSITE,
  normalizeWebsite,
  type VaultSecret,
} from "@mindfultech/shared";
import { useMemo, useState, type FormEvent } from "react";
import { channelLabel, displayName } from "../lib/channels";
import { TasksApiError } from "../lib/tasksApi";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { EyeIcon, EyeOffIcon, LockIcon, WandIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { PRIMARY_BUTTON } from "./SkillsView";

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

/**
 * "Create Secret": title, website, username, password (typed or generated)
 * and the channel (project) whose members may see it. The password goes
 * straight to the server, which encrypts it with KMS; nothing is kept here.
 */
export function CreateSecretModal({
  defaultChannelId,
  onClose,
  onSaved,
}: Readonly<{
  defaultChannelId?: string;
  onClose: () => void;
  onSaved: (secret: VaultSecret) => void;
}>) {
  const showToast = useChat((s) => s.showToast);
  const channels = useVaultChannels();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [channelId, setChannelId] = useState(
    channels.some((c) => c.channelId === defaultChannelId)
      ? defaultChannelId!
      : (channels[0]?.channelId ?? ""),
  );
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const websiteInvalid = website.trim() !== "" && !normalizeWebsite(website);
  const canSave = !!name.trim() && !!password.trim() && !!channelId && !websiteInvalid && !busy;

  function generate() {
    setPassword(generatePassword());
    setVisible(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await vaultApi.create({
        channelId,
        name: name.trim(),
        password,
        ...(username.trim() && { username: username.trim() }),
        ...(website.trim() && { website: website.trim() }),
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
      title="Create Secret"
      onClose={onClose}
      width="md"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="vault-create"
            className={PRIMARY_BUTTON}
            disabled={!canSave}
            data-vault-save
          >
            <LockIcon aria-hidden="true" />
            {busy ? "Encrypting…" : "Save secret"}
          </button>
        </>
      }
    >
      <form
        id="vault-create"
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
            <label htmlFor="vault-password">Password</label>
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
              required
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
          <span className="text-xs font-normal text-ink-secondary">
            Only members of this channel can reveal or copy it.
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={share}
            onChange={(e) => setShare(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Also post a 🔒 card in the channel
        </label>
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}
        <p className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-ink-secondary">
          <LockIcon className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          Encrypted with AWS KMS before it&apos;s stored. Every reveal is logged.
        </p>
      </form>
    </Modal>
  );
}
