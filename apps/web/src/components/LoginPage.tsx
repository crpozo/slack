import { useState, type FormEvent } from "react";
import logoUrl from "../assets/brand/logo.png";
import { setNewPassword, signIn, type SessionUser } from "../lib/auth";

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

export function LoginPage({ onSignedIn }: Readonly<{ onSignedIn: (user: SessionUser) => void }>) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** First sign-in with a temporary password (an emailed invitation): choose your own. */
  const [choosing, setChoosing] = useState(false);
  const [newPassword, setNewPasswordValue] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (choosing) {
        onSignedIn(await setNewPassword(newPassword));
        return;
      }
      const result = await signIn(email, password);
      if ("user" in result) {
        onSignedIn(result.user);
        return;
      }
      setChoosing(true);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
      setBusy(false);
    }
  }

  const submitLabel = choosing ? "Set password and sign in" : "Sign in";

  return (
    <div className="flex min-h-full items-center justify-center bg-surface-sidebar px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo />
          <h1 className="text-2xl font-semibold text-ink">MindfulTech Slack</h1>
          <p className="text-sm text-ink-secondary">Sign in with your team account</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
          noValidate
        >
          {choosing ? (
            <div className="space-y-1.5">
              <p className="text-sm text-ink-secondary">
                Welcome! Choose your own password to finish signing in (at least 8 characters).
              </p>
              <label htmlFor="new-password" className="text-sm font-medium text-ink">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                autoFocus
                className="input"
                value={newPassword}
                onChange={(e) => setNewPasswordValue(e.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-sm font-medium text-ink">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@mindfultech.ec"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-sm font-medium text-ink">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={busy || (choosing ? newPassword.length < 8 : !email || !password)}
          >
            {busy ? "Signing in…" : submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
}
