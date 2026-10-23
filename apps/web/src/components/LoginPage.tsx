import { useState, type FormEvent, type ReactNode } from "react";
import logoUrl from "../assets/brand/logo.png";
import {
  ChallengeExpiredError,
  confirmPasswordReset,
  requestPasswordReset,
  setNewPassword,
  signIn,
  type SessionUser,
  type SignInResult,
} from "../lib/auth";
import { NewPasswordFields, newPasswordProblem, PasswordInput } from "./PasswordFields";

/** The official MindfulTech logo (generated from `public/logo.webp` by `pnpm --filter web icons`). */
export function Logo() {
  return (
    <img
      src={logoUrl}
      alt="MindfulTech"
      width={40}
      height={40}
      className="h-10 w-10 shrink-0 rounded-xl object-contain"
    />
  );
}

/**
 * Where the sign-in screen is:
 * - `signIn`: email and password;
 * - `newPassword`: first sign-in with an emailed temporary password, choose your own;
 * - `forgot`: ask Cognito to email a reset code;
 * - `reset`: the code and a new password.
 */
type Step = "signIn" | "newPassword" | "forgot" | "reset";

const SUBTITLES: Record<Step, string> = {
  signIn: "Sign in with your team account",
  newPassword: "Choose your password",
  forgot: "Reset your password",
  reset: "Reset your password",
};

const SUBMIT_LABELS: Record<Step, [idle: string, busy: string]> = {
  signIn: ["Sign in", "Signing in…"],
  newPassword: ["Set password and sign in", "Signing in…"],
  forgot: ["Email me a code", "Sending…"],
  reset: ["Reset password and sign in", "Resetting…"],
};

function TextLink({ onClick, children }: Readonly<{ onClick: () => void; children: ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm font-medium text-ink underline decoration-primary decoration-2 underline-offset-2 hover:decoration-ink"
    >
      {children}
    </button>
  );
}

export function LoginPage({ onSignedIn }: Readonly<{ onSignedIn: (user: SessionUser) => void }>) {
  const [step, setStep] = useState<Step>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Neutral news: where the code went, why you're back at sign-in. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function goTo(next: Step, message: string | null = null) {
    setStep(next);
    setError(null);
    setNotice(message);
    setNewPasswordValue("");
    setConfirm("");
    if (next === "signIn" || next === "forgot") setCode("");
  }

  /** A sign-in that may still want a new password (a reset of a never-used invite can't). */
  function finish(result: SignInResult) {
    if ("user" in result) return onSignedIn(result.user);
    setPassword("");
    goTo("newPassword");
    setBusy(false);
  }

  async function sendCode(): Promise<void> {
    const destination = await requestPasswordReset(email);
    setCode("");
    goTo(
      "reset",
      destination
        ? `If ${email.trim()} has an account, we sent a code to ${destination}.`
        : `If ${email.trim()} has an account, we sent it a code.`,
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      switch (step) {
        case "signIn":
          return finish(await signIn(email, password));
        case "newPassword":
          return onSignedIn(await setNewPassword(newPassword));
        case "forgot":
          await sendCode();
          break;
        case "reset":
          return finish(await confirmPasswordReset(email, code, newPassword));
      }
    } catch (err) {
      if (err instanceof ChallengeExpiredError) {
        setPassword("");
        goTo("signIn", err.message);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      }
    }
    setBusy(false);
  }

  async function resend() {
    setError(null);
    setBusy(true);
    try {
      await sendCode();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the code.");
    }
    setBusy(false);
  }

  const choosing = step === "newPassword" || step === "reset";
  const ready = {
    signIn: email.trim() !== "" && password !== "",
    newPassword: newPasswordProblem(newPassword, confirm) === null,
    forgot: email.trim() !== "",
    reset: code.trim() !== "" && newPasswordProblem(newPassword, confirm) === null,
  }[step];
  const [idleLabel, busyLabel] = SUBMIT_LABELS[step];

  return (
    <div className="flex min-h-full items-center justify-center bg-surface-sidebar px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo />
          <h1 className="text-2xl font-semibold text-ink">MindfulTech Slack</h1>
          <p className="text-sm text-ink-secondary">{SUBTITLES[step]}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
          aria-label={SUBTITLES[step]}
          noValidate
        >
          {notice && (
            <p role="status" className="rounded-lg bg-surface-sidebar px-3 py-2 text-sm text-ink">
              {notice}
            </p>
          )}

          {step === "newPassword" && (
            <p className="text-sm text-ink-secondary">
              Welcome! You signed in with a temporary password. Choose your own to finish.
            </p>
          )}
          {step === "forgot" && (
            <p className="text-sm text-ink-secondary">
              Enter your email and we&apos;ll send you a code to choose a new password.
            </p>
          )}

          {(step === "signIn" || step === "forgot") && (
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium text-ink">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                autoFocus={step === "forgot"}
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@mindfultech.ec"
              />
            </div>
          )}

          {step === "signIn" && (
            <div className="space-y-1.5">
              <PasswordInput
                id="password"
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                shown={showPassword}
                onToggleShown={() => setShowPassword(!showPassword)}
              />
              <div className="text-right">
                <TextLink onClick={() => goTo("forgot")}>Forgot password?</TextLink>
              </div>
            </div>
          )}

          {step === "reset" && (
            <div className="space-y-1.5">
              <label htmlFor="reset-code" className="text-sm font-medium text-ink">
                Code from the email
              </label>
              <input
                id="reset-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus
                maxLength={12}
                className="input tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
              />
            </div>
          )}

          {choosing && (
            <NewPasswordFields
              idPrefix="new"
              value={newPassword}
              confirm={confirm}
              onChange={setNewPasswordValue}
              onConfirmChange={setConfirm}
              autoFocus={step === "newPassword"}
            />
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
            >
              {error}
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={busy || !ready}>
            {busy ? busyLabel : idleLabel}
          </button>

          {step !== "signIn" && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TextLink
                onClick={() => {
                  setPassword("");
                  goTo("signIn");
                }}
              >
                Back to sign in
              </TextLink>
              {step === "reset" && (
                <TextLink onClick={() => void resend()}>Send a new code</TextLink>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
