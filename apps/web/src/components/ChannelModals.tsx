import { CHANNEL_NAME_PATTERN, type ChannelVisibility, type Channel } from "@mindfultech/shared";
import { useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { chat } from "../lib/chat";
import { normalizeChannelName } from "../lib/channels";
import { useChat } from "../store";
import { GlobeIcon, LockIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { UserPicker } from "./UserPicker";

/** Everyone in the directory except me, sorted by display name. */
function useOtherUsers() {
  const myUserId = useChat((s) => s.me?.userId);
  const users = useChat(useShallow((s) => Object.values(s.users)));
  return users
    .filter((u) => u.userId !== myUserId)
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
  const name = normalizeChannelName(value);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!CHANNEL_NAME_PATTERN.test(name)) {
      setError("Use lowercase letters, numbers or hyphens (max. 32).");
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
            placeholder="e.g. web-design"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          {value && name !== value && (
            <p className="text-xs text-ink-secondary">Will be created as #{name}</p>
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
