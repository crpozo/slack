import {
  VAULT_PIN_LENGTH,
  vaultPinProblem,
  type VaultPinStatus,
  type VaultUnlock,
} from "@mindfultech/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { pinErrorText, pinRefusalOf, vaultApi } from "../lib/vaultApi";
import { LockIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";
import { GLASS_CARD, PRIMARY_BUTTON } from "./SkillsView";

/**
 * Four boxes over one numeric input (so paste, autofill and the phone's
 * number pad all work), each showing a dot once filled. Calls `onComplete`
 * with the fourth digit.
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  disabled,
  label,
  autoFocus = true,
  invalid = false,
}: Readonly<{
  value: string;
  onChange: (pin: string) => void;
  onComplete?: (pin: string) => void;
  disabled?: boolean;
  label: string;
  autoFocus?: boolean;
  invalid?: boolean;
}>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus();
  }, [autoFocus, disabled]);
  return (
    <div className="relative mx-auto w-fit" onClick={() => ref.current?.focus()}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => {
          const pin = e.target.value.replace(/\D/g, "").slice(0, VAULT_PIN_LENGTH);
          onChange(pin);
          if (pin.length === VAULT_PIN_LENGTH) onComplete?.(pin);
        }}
        disabled={disabled}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={VAULT_PIN_LENGTH}
        aria-label={label}
        aria-invalid={invalid}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        data-pin-input
      />
      <div className="pointer-events-none flex gap-3" aria-hidden="true">
        {Array.from({ length: VAULT_PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`flex h-14 w-12 items-center justify-center rounded-xl border bg-black/25 text-2xl text-ink transition ${
              invalid
                ? "border-error/70"
                : i === value.length
                  ? "border-primary shadow-[0_0_0_3px_rgb(64_179_117/0.2)]"
                  : "border-white/15"
            }`}
          >
            {i < value.length ? "•" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const lockedText = (until: number) =>
  `Too many wrong PINs. Try again at ${new Date(until).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}.`;

/**
 * The Vault's lock screen (Phase 46): nothing of the Vault shows until the
 * PIN is right. The first visit sets the PIN (twice, to confirm). Five wrong
 * PINs lock it on the server for a while.
 */
export function VaultLockScreen({
  onUnlocked,
}: Readonly<{ onUnlocked: (session: VaultUnlock) => void }>) {
  const [status, setStatus] = useState<VaultPinStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [first, setFirst] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    vaultApi.pinStatus().then(
      (s) => {
        if (!live) return;
        setStatus(s);
        if (s.lockedUntil) setLockedUntil(s.lockedUntil);
      },
      (err: unknown) => live && setLoadError(pinErrorText(err)),
    );
    return () => {
      live = false;
    };
  }, []);
  // A lock lifts by itself.
  useEffect(() => {
    if (!lockedUntil) return;
    const t = setTimeout(() => setLockedUntil(null), Math.max(0, lockedUntil - Date.now()));
    return () => clearTimeout(t);
  }, [lockedUntil]);

  const creating = status !== null && !status.hasPin;

  async function submit(value: string) {
    if (busy || value.length !== 4) return;
    setError(null);
    if (creating && first === null) {
      const problem = vaultPinProblem(value);
      if (problem) {
        setError(problem);
        setPin("");
        return;
      }
      setFirst(value);
      setPin("");
      return;
    }
    if (creating && value !== first) {
      setError("The PINs don't match. Choose your PIN again.");
      setFirst(null);
      setPin("");
      return;
    }
    setBusy(true);
    try {
      onUnlocked(creating ? await vaultApi.setPin(value) : await vaultApi.unlock(value));
    } catch (err) {
      const refusal = pinRefusalOf(err);
      if (refusal?.lockedUntil) setLockedUntil(refusal.lockedUntil);
      setError(pinErrorText(err));
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  const title = creating
    ? first === null
      ? "Create your Vault PIN"
      : "Confirm your Vault PIN"
    : "Enter your Vault PIN";
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10" data-vault-lock>
      <div className={`${GLASS_CARD} flex w-full max-w-sm flex-col items-center gap-5 p-8`}>
        <span
          className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/40 bg-primary/15 text-2xl text-primary shadow-[0_0_30px_rgb(64_179_117/0.25)]"
          aria-hidden="true"
        >
          <LockIcon />
        </span>
        <div className="text-center">
          <h1 className="text-xl font-bold text-ink">{status ? title : "Vault"}</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {creating
              ? "4 digits that open the Vault and every password in it. Avoid 1234 or 0000."
              : "The Vault is locked. Your PIN opens it, and is asked again for each password."}
          </p>
        </div>
        {loadError ? (
          <p className="text-sm text-error" role="alert">
            {loadError}
          </p>
        ) : status === null ? (
          <div className="h-14" aria-busy="true" aria-label="Checking the Vault" />
        ) : (
          <PinInput
            key={first === null ? "first" : "confirm"}
            value={pin}
            onChange={(v) => {
              setPin(v);
              if (v) setError(null);
            }}
            onComplete={(v) => void submit(v)}
            disabled={busy || !!lockedUntil}
            label={title}
            invalid={!!error}
          />
        )}
        <p
          className={`min-h-5 text-center text-sm ${lockedUntil ? "text-warning" : "text-error"}`}
          role="status"
        >
          {lockedUntil ? lockedText(lockedUntil) : error}
        </p>
        {!creating && status && (
          <p className="text-center text-xs text-ink-secondary">
            Forgot your PIN? An admin can reset it for you.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Asks for the PIN again before a password is revealed or copied (Phase 46).
 * `onSubmit` runs the reveal; a wrong PIN keeps the prompt open with the
 * tries left, a lock closes nothing but says until when.
 */
export function PinPrompt({
  title,
  onSubmit,
  onClose,
}: Readonly<{ title: string; onSubmit: (pin: string) => Promise<void>; onClose: () => void }>) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(value = pin, e?: FormEvent) {
    e?.preventDefault();
    if (busy || value.length !== 4) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setError(pinErrorText(err));
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="submit"
            form="vault-pin-prompt"
            className={PRIMARY_BUTTON}
            disabled={busy || pin.length !== 4}
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
        </>
      }
    >
      <form
        id="vault-pin-prompt"
        className="flex flex-col items-center gap-4 py-2"
        onSubmit={(e) => void submit(pin, e)}
        data-pin-prompt
      >
        <p className="text-center text-sm text-ink-secondary">Enter your Vault PIN to continue.</p>
        <PinInput
          value={pin}
          onChange={(v) => {
            setPin(v);
            if (v) setError(null);
          }}
          onComplete={(v) => void submit(v)}
          disabled={busy}
          label="Vault PIN"
          invalid={!!error}
        />
        <p className="min-h-5 text-center text-sm text-error" role="alert">
          {error}
        </p>
      </form>
    </Modal>
  );
}
