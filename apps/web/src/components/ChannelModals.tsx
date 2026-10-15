import {
  ChannelNameSchema,
  MAX_CHANNEL_NAME_LENGTH,
  slugifyChannelName,
  type ChannelVisibility,
  type Channel,
} from "@mindfultech/shared";
import { useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { useChat } from "../store";
import { GlobeIcon, LockIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { UserPicker } from "./UserPicker";

/** Everyone in the directory except me and guests (who can't chat), sorted by display name. */
function useOtherUsers() {
  const myUserId = useChat((s) => s.me?.userId);
  const users = useChat(useShallow((s) => Object.values(s.users)));
  return users
    .filter((u) => u.userId !== myUserId && u.role !== "guest")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

const VISIBILITY: Array<{
  value: ChannelVisibility;
  label: string;
  hint: string;
  Icon: typeof LockIcon;
}> = [
  { value: "private", label: "Private", hint: "Only people you invite", Icon: LockIcon },
  { value: "public", label: "Public", hint: "Visible to the whole team", Icon: GlobeIcon },
];

export function CreateChannelModal({
  onClose,
  onCreated,
}: Readonly<{
  onClose: () => void;
  onCreated: (channelId: string) => void;
}>) {
  const others = useOtherUsers();
  const [value, setValue] = useState("");
  const [visibility, setVisibility] = useState<ChannelVisibility>("private");
  const [invitees, setInvitees] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The name is saved as typed ("Web Design"); the slug only guards uniqueness.
  const name = value.trim();
  const slug = slugifyChannelName(value);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ChannelNameSchema.safeParse(name).success) {
      setError(`Use up to ${MAX_CHANNEL_NAME_LENGTH} characters, including a letter or number.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await chat.createChannel(name, visibility, visibility === "private" ? invitees : []),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the channel.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create channel"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="create-channel"
            className="btn-primary"
            disabled={busy || !name}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <form id="create-channel" onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="channel-name" className="text-sm font-medium text-ink">
            Name
          </label>
          <input
            id="channel-name"
            className="input"
            placeholder="e.g. Web Design"
            value={value}
            maxLength={MAX_CHANNEL_NAME_LENGTH}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          {name && !slug && (
            <p className="text-xs text-ink-secondary">Include at least one letter or number.</p>
          )}
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">Visibility</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Visibility">
            {VISIBILITY.map(({ value: v, label, hint, Icon }) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={visibility === v}
                onClick={() => setVisibility(v)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  visibility === v
                    ? "border-primary bg-primary/15"
                    : "border-line hover:bg-surface-hover"
                }`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <Icon /> {label}
                </span>
                <span className="mt-0.5 block text-xs text-ink-secondary">{hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {visibility === "private" && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-ink">
              Invite people{" "}
              <span className="font-normal text-ink-secondary">({invitees.length} selected)</span>
            </p>
            <UserPicker users={others} selected={invitees} onChange={setInvitees} />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Invite more people to a private channel (only its creator sees this). */
export function InviteModal({
  channel,
  onClose,
}: Readonly<{ channel: Channel; onClose: () => void }>) {
  const others = useOtherUsers();
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <Modal
      title={`Invite to #${channel.name}`}
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            className="btn-primary"
            disabled={selected.length === 0}
            onClick={() => {
              chat.invite(channel.channelId, selected);
              onClose();
            }}
          >
            Invite{selected.length > 0 ? ` (${selected.length})` : ""}
          </button>
        </>
      }
    >
      <UserPicker
        users={others}
        selected={selected}
        onChange={setSelected}
        locked={channel.members ?? []}
      />
    </Modal>
  );
}

/** Start a direct message with anyone in the directory (the "+" next to Direct messages). */
export function NewDmModal({
  onClose,
  onOpened,
}: Readonly<{ onClose: () => void; onOpened: (channelId: string) => void }>) {
  const others = useOtherUsers();
  return (
    <Modal
      title="New direct message"
      onClose={onClose}
      footer={<SecondaryButton onClick={onClose}>Cancel</SecondaryButton>}
    >
      <UserPicker
        users={others}
        selected={[]}
        mode="single"
        onChange={([userId]) => {
          const channelId = userId && chat.openDm(userId);
          if (channelId) onOpened(channelId);
        }}
      />
    </Modal>
  );
}

/**
 * Confirms deleting a channel or DM. The server pushes `channel.deleted` to
 * everyone who could see it; ChatLayout then moves whoever is viewing it away.
 */
export function DeleteChannelModal({
  channel,
  label,
  onClose,
}: Readonly<{ channel: Channel; label: string; onClose: () => void }>) {
  const dm = channel.type === "dm";
  return (
    <Modal
      title={dm ? "Delete conversation" : "Delete channel"}
      width="sm"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg bg-error px-4 py-2 text-sm font-semibold text-on-accent hover:opacity-90"
            onClick={() => {
              chat.deleteChannel(channel.channelId);
              onClose();
            }}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="text-sm text-ink">
        {dm ? (
          <>
            Delete your conversation with <strong>{label}</strong>? All of its messages will be
            removed for both of you.
          </>
        ) : (
          <>
            Delete <strong>{label}</strong>? All of its messages will be removed and it will
            disappear for every member.
          </>
        )}
      </p>
      <p className="mt-2 text-xs text-ink-secondary">This can't be undone.</p>
    </Modal>
  );
}

/**
 * Renames a channel (its creator or an admin). The link and history stay; a
 * name already taken by another channel comes back as an error toast.
 */
export function RenameChannelModal({
  channel,
  onClose,
}: Readonly<{ channel: Channel; onClose: () => void }>) {
  const [name, setName] = useState(channel.name);
  const parsed = ChannelNameSchema.safeParse(name);
  const changed = name.trim() !== channel.name;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed.success || !changed) return;
    chat.renameChannel(channel.channelId, name);
    onClose();
  }

  return (
    <Modal
      title="Rename channel"
      width="sm"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="rename-channel"
            className="btn-primary"
            disabled={!parsed.success || !changed}
          >
            Rename
          </button>
        </>
      }
    >
      <form id="rename-channel" onSubmit={submit} className="space-y-1.5">
        <label htmlFor="channel-name" className="text-sm font-medium text-ink">
          Name
        </label>
        <input
          id="channel-name"
          className="input"
          value={name}
          maxLength={MAX_CHANNEL_NAME_LENGTH}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-ink-secondary">
          Everyone in the channel sees the new name. Links and messages stay as they are.
        </p>
      </form>
    </Modal>
  );
}
