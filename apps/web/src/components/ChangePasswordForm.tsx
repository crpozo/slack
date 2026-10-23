import { useState, type FormEvent } from "react";
import { changePassword } from "../lib/auth";
import { NewPasswordFields, newPasswordProblem, PasswordInput } from "./PasswordFields";

/**
 * Change your password while signed in (Settings, or the guest header).
 * Cognito wants the current password too; other signed-in devices stay
 * signed in.
 */
export function ChangePasswordForm({ onChanged }: Readonly<{ onChanged?: () => void }>) {
  const [current, setCurrent] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const problem = newPasswordProblem(next, confirm);
  const ready = current !== "" && problem === null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    if (next === current) {
      setError("Choose a password different from your current one.");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change your password.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label="Change password" noValidate>
      <PasswordInput
        id="current-password"
        label="Current password"
        value={current}
        onChange={(v) => {
          setCurrent(v);
          setDone(false);
        }}
        autoComplete="current-password"
        shown={showCurrent}
        onToggleShown={() => setShowCurrent(!showCurrent)}
      />
      <NewPasswordFields
        idPrefix="change"
        value={next}
        confirm={confirm}
        onChange={(v) => {
          setNext(v);
          setDone(false);
        }}
        onConfirmChange={setConfirm}
      />
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
        >
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-ink">
          Your password was changed. Use it the next time you sign in.
        </p>
      )}
      <button type="submit" className="btn-primary" disabled={busy || !ready}>
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
