import { useState } from "react";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "../lib/auth";
import { CheckIcon, EyeIcon, EyeOffIcon } from "./icons";

/** A password input with an optional show/hide toggle inside it. */
export function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  shown = false,
  onToggleShown,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  shown?: boolean;
  onToggleShown?: () => void;
}>) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          autoFocus={autoFocus}
          className={`input ${onToggleShown ? "pr-10" : ""}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {onToggleShown && (
          <button
            type="button"
            onClick={onToggleShown}
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            aria-controls={id}
            title={shown ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </div>
    </div>
  );
}

/** Why a new password (and its confirmation) can't be used yet, or `null`. */
export function newPasswordProblem(value: string, confirm: string): string | null {
  return passwordProblem(value) ?? (confirm === value ? null : "The passwords don't match.");
}

/**
 * "New password" + "Confirm password", one show/hide toggle for both, and the
 * pool's rules ticked off as they're met (Cognito: 8+ characters, no space at
 * either end).
 */
export function NewPasswordFields({
  idPrefix,
  value,
  confirm,
  onChange,
  onConfirmChange,
  autoFocus,
  label = "New password",
}: Readonly<{
  idPrefix: string;
  value: string;
  confirm: string;
  onChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  autoFocus?: boolean;
  label?: string;
}>) {
  const [shown, setShown] = useState(false);
  const rules = [
    { ok: value.length >= MIN_PASSWORD_LENGTH, text: `At least ${MIN_PASSWORD_LENGTH} characters` },
    { ok: value.length > 0 && value.trim() === value, text: "No space at the start or end" },
    { ok: confirm.length > 0 && confirm === value, text: "Both passwords match" },
  ];
  return (
    <div className="space-y-3">
      <PasswordInput
        id={`${idPrefix}-password`}
        label={label}
        value={value}
        onChange={onChange}
        autoComplete="new-password"
        autoFocus={autoFocus}
        shown={shown}
        onToggleShown={() => setShown(!shown)}
      />
      <PasswordInput
        id={`${idPrefix}-confirm`}
        label="Confirm password"
        value={confirm}
        onChange={onConfirmChange}
        autoComplete="new-password"
        shown={shown}
      />
      <ul aria-label="Password requirements" className="space-y-0.5 text-xs">
        {rules.map((rule) => (
          <li
            key={rule.text}
            className={`flex items-center gap-1.5 ${rule.ok ? "text-ink" : "text-ink-secondary"}`}
            data-met={rule.ok}
          >
            {rule.ok ? (
              <CheckIcon className="text-success" aria-hidden="true" />
            ) : (
              <span aria-hidden="true" className="inline-block w-[1em] text-center">
                ·
              </span>
            )}
            {rule.text}
            <span className="sr-only">{rule.ok ? " (done)" : " (not yet)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
