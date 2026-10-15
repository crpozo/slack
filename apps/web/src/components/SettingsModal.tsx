import { MAX_DISPLAY_NAME_LENGTH } from "@mindfultech/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { chat } from "../lib/chat";
import {
  listInputDevices,
  loadMediaPrefs,
  mediaErrorText,
  saveMediaPrefs,
  supportsCalls,
  type InputDevices,
  type MediaPrefs,
} from "../lib/media";
import { isDesktopApp } from "../lib/desktop";
import { disablePush, enablePush, usePush, type PushStatus } from "../lib/push";
import {
  onSoundsChange,
  onVolumeChange,
  previewMessageSound,
  setSoundsEnabled,
  setSoundVolume,
  soundsEnabled,
  soundVolume,
} from "../lib/sounds";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";
import { useChat, useNameOf } from "../store";
import { Avatar } from "./Avatar";
import { CameraPreview } from "./CameraPreview";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";

const THEMES: Array<{ value: ThemePreference; label: string; Icon: typeof SunIcon }> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

function DeviceSelect({
  id,
  label,
  devices,
  value,
  fallbackName,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  fallbackName: string;
  onChange: (deviceId: string) => void;
}>) {
  const missing = value !== "" && !devices.some((d) => d.deviceId === value);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-secondary">
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">System default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${fallbackName} ${i + 1}`}
          </option>
        ))}
        {missing && <option value={value}>Saved device (not connected)</option>}
      </select>
    </div>
  );
}

/** Preferred microphone and camera for calls, saved as soon as they are picked. */
function DeviceSettings() {
  const [devices, setDevices] = useState<InputDevices | null>(null);
  const [prefs, setPrefs] = useState<MediaPrefs>(loadMediaPrefs);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await listInputDevices());
    } catch {
      setDevices({ microphones: [], cameras: [], labelled: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const media = navigator.mediaDevices;
    const onChange = () => void refresh();
    media?.addEventListener("devicechange", onChange);
    return () => media?.removeEventListener("devicechange", onChange);
  }, [refresh]);

  /** Device names are hidden until the site has had media access once. */
  async function allowAccess() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      setError(mediaErrorText(err, "microphone and camera"));
    }
    await refresh();
  }

  function choose(key: keyof MediaPrefs, deviceId: string) {
    const next = { ...prefs, [key]: deviceId };
    setPrefs(next);
    saveMediaPrefs(next);
  }

  if (!supportsCalls()) {
    return <p className="text-xs text-ink-secondary">This browser doesn&apos;t support calls.</p>;
  }
  return (
    <div className="space-y-3">
      <DeviceSelect
        id="microphone"
        label="Microphone"
        devices={devices?.microphones ?? []}
        value={prefs.audioInputId}
        fallbackName="Microphone"
        onChange={(id) => choose("audioInputId", id)}
      />
      <DeviceSelect
        id="camera"
        label="Camera"
        devices={devices?.cameras ?? []}
        value={prefs.videoInputId}
        fallbackName="Camera"
        onChange={(id) => choose("videoInputId", id)}
      />
      <CameraPreview deviceId={prefs.videoInputId} />
      {devices && !devices.labelled && (
        <button
          type="button"
          onClick={() => void allowAccess()}
          className="text-sm font-medium text-ink underline decoration-primary decoration-2 underline-offset-2"
        >
          Allow access to see your devices
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <p className="text-xs text-ink-secondary">
        Used for calls. A change applies to your next call or when you turn your camera back on.
      </p>
    </div>
  );
}

const PUSH_HINT: Record<PushStatus, string> = {
  on: "This device gets a notification for direct messages and @mentions while you're away.",
  off: "Get a notification for direct messages and @mentions while you're away.",
  denied:
    "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
  "needs-install":
    "On iPhone and iPad: tap Share → Add to Home Screen, open the app from there, then turn this on.",
  unconfigured: "Push notifications aren't set up on this deployment yet.",
  unsupported: isDesktopApp()
    ? "The desktop app shows its own notifications for direct messages and @mentions."
    : "This browser doesn't support push notifications.",
};

/** "Push notifications" switch for this device. */
function PushSettings() {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const { status, busy, lastError } = usePush();
  const available = status === "on" || status === "off";

  async function toggle(on: boolean) {
    if (!me) return;
    try {
      if (on) await enablePush(me.userId);
      else await disablePush(me.userId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't change notifications.");
    }
  }

  return (
    <label
      aria-label="Push notifications"
      className={`flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 ${
        available ? "cursor-pointer" : "opacity-80"
      }`}
    >
      <span>
        <span className="block text-sm font-medium text-ink">Push notifications</span>
        <span className="block text-xs text-ink-secondary">{PUSH_HINT[status]}</span>
        {status !== "on" && lastError && (
          <span className="mt-0.5 block text-xs text-error" role="status">
            Last attempt failed: {lastError}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={status === "on"}
        checked={status === "on"}
        disabled={!available || busy}
        onChange={(e) => void toggle(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-6 w-11 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-primary peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-surface after:shadow after:transition-transform peer-checked:after:translate-x-5"
      />
    </label>
  );
}

/** "Play notification sounds" switch; applies and saves immediately. */
function NotificationSettings() {
  const [enabled, setEnabled] = useState(soundsEnabled);
  useEffect(() => onSoundsChange(setEnabled), []);
  return (
    <label
      aria-label="Play notification sounds"
      className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5"
    >
      <span>
        <span className="block text-sm font-medium text-ink">Play notification sounds</span>
        <span className="block text-xs text-ink-secondary">
          Ringing for calls and a knock for new messages in other conversations.{" "}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault(); // inside the label: don't flip the switch
              previewMessageSound();
            }}
            className="font-medium text-ink underline decoration-primary decoration-2 underline-offset-2"
          >
            Play test
          </button>
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={enabled}
        checked={enabled}
        onChange={(e) => setSoundsEnabled(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-6 w-11 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-surface after:shadow after:transition-transform peer-checked:after:translate-x-5"
      />
    </label>
  );
}

/** How often the slider may replay the preview while it's being dragged. */
const PREVIEW_EVERY_MS = 250;

/**
 * Volume of the notification sounds (0–1), saved on this device. Moving the
 * slider plays the message sound at the new level so you hear what you pick.
 */
function VolumeSettings() {
  const [volume, setVolume] = useState(soundVolume);
  const [enabled, setEnabled] = useState(soundsEnabled);
  const lastPreview = useRef(0);
  useEffect(() => onVolumeChange(setVolume), []);
  useEffect(() => onSoundsChange(setEnabled), []);

  const change = (value: number) => {
    setSoundVolume(value);
    const now = Date.now();
    if (now - lastPreview.current < PREVIEW_EVERY_MS) return;
    lastPreview.current = now;
    previewMessageSound();
  };

  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <label htmlFor="sound-volume" className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">Notification volume</span>
        <span className="text-xs tabular-nums text-ink-secondary">
          {Math.round(volume * 100)} %
        </span>
      </label>
      <input
        id="sound-volume"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        disabled={!enabled}
        onChange={(e) => change(Number(e.target.value))}
        // Releasing the slider always plays the final level, even mid-throttle.
        onPointerUp={() => previewMessageSound()}
        className="mt-2 w-full accent-primary disabled:opacity-50"
        aria-valuetext={`${Math.round(volume * 100)} percent`}
      />
      <p className="text-xs text-ink-secondary">
        {enabled
          ? "On iPhone and iPad the device's volume buttons decide instead."
          : "Turn on notification sounds to change the volume."}
      </p>
    </div>
  );
}

/** Profile (display name), appearance (theme) and call devices. */
export function SettingsModal({ onClose }: Readonly<{ onClose: () => void }>) {
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

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Notifications</h3>
          <PushSettings />
          <NotificationSettings />
          <VolumeSettings />
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Audio &amp; Video</h3>
          <DeviceSettings />
        </section>
      </form>
    </Modal>
  );
}
