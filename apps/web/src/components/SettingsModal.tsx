import { MAX_DISPLAY_NAME_LENGTH } from "@mindfultech/shared";
import { useState, type FormEvent } from "react";
import { chat } from "../lib/chat";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";
import { useChat, useNameOf } from "../store";
import { Avatar } from "./Avatar";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";

const THEMES: Array<{ value: ThemePreference; label: string; Icon: typeof SunIcon }> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

/** Profile (display name) and appearance (theme). */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useChat((s) => s.me);
  const nameOf = useNameOf();
  const current = me ? nameOf(me.userId, me.email) : "";
  const [name, setName] = useState(current);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_DISPLAY_NAME_LENGTH;
  const changed = trimmed !== current;

  function chooseTheme(value: ThemePreference) {
    setTheme(value);
    setThemePreference(value); // applies immediately
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!changed) return onClose();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await chat.updateDisplayName(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
      setSaving(false);
    }
  }

  if (!me) return null;
  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="settings-form"
            className="btn-primary"
            disabled={saving || !valid}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="settings-form" onSubmit={handleSubmit} className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Profile</h3>
          <div className="flex items-center gap-3">
            <Avatar name={trimmed || me.email} mine />
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor="display-name" className="text-xs font-medium text-ink-secondary">
                Display name
              </label>
              <input
                id="display-name"
                className="input"
                value={name}
                maxLength={MAX_DISPLAY_NAME_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder="How should others see you?"
              />
            </div>
          </div>
          <p className="text-xs text-ink-secondary">
            This is what your team sees in messages and the sidebar. Your email ({me.email})
            doesn&apos;t change.
          </p>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
            >
              {error}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Theme</h3>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => chooseTheme(value)}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm transition-colors ${
                  theme === value
                    ? "border-primary bg-primary/15 font-semibold text-ink"
                    : "border-line text-ink-secondary hover:bg-surface-hover hover:text-ink"
                }`}
              >
                <Icon className="text-lg" />
                {label}
              </button>
            ))}
          </div>
        </section>
      </form>
    </Modal>
  );
}
