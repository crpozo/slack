import { roleFromGroups, type Role } from "@mindfultech/shared";
import { Amplify } from "aws-amplify";
import {
  confirmResetPassword,
  confirmSignIn,
  fetchAuthSession,
  resetPassword,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  updatePassword,
} from "aws-amplify/auth";

export interface SessionUser {
  userId: string;
  email: string;
  /** From the id token's Cognito groups (the server enforces it; the UI follows it). */
  role: Role;
}

/** Cognito usernames here are emails, matched case-insensitively. */
const usernameOf = (email: string) => email.trim().toLowerCase();

/** Thrown when there is no (refreshable) Cognito session left. */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
}

export function configureAuth(userPoolId: string, userPoolClientId: string): void {
  Amplify.configure({
    Auth: { Cognito: { userPoolId, userPoolClientId, loginWith: { email: true } } },
  });
}

/** Current user from the id token (Amplify refreshes it transparently), or `null`. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  try {
    const payload = (await fetchAuthSession()).tokens?.idToken?.payload;
    if (!payload?.sub || typeof payload.email !== "string") return null;
    return {
      userId: payload.sub,
      email: payload.email,
      role: roleFromGroups(payload["cognito:groups"]),
    };
  } catch {
    return null;
  }
}

/** Fresh id token for the WebSocket handshake. */
export async function getIdToken(): Promise<string> {
  const token = (await fetchAuthSession()).tokens?.idToken?.toString();
  if (!token) throw new SessionExpiredError("No active session");
  return token;
}

/** Thrown when the "choose a password" step outlived Cognito's 3-minute session. */
export class ChallengeExpiredError extends Error {
  override name = "ChallengeExpiredError";
}

/** What the user was doing when Cognito said no: the same error means different things. */
export type AuthAction = "signIn" | "newPassword" | "requestReset" | "confirmReset" | "change";

const ERROR_MESSAGES: Record<string, string> = {
  NotAuthorizedException: "Incorrect email or password.",
  UserNotFoundException: "Incorrect email or password.",
  UserNotConfirmedException: "Your account is not confirmed yet. Contact your administrator.",
  PasswordResetRequiredException:
    "You need to reset your password: use “Forgot password?” to get a code by email.",
  LimitExceededException: "Too many attempts. Wait a moment and try again.",
  TooManyRequestsException: "Too many attempts. Wait a moment and try again.",
  TooManyFailedAttemptsException: "Too many attempts. Wait a moment and try again.",
  EmptySignInUsername: "Enter your email.",
  EmptySignInPassword: "Enter your password.",
  EmptyResetPasswordUsername: "Enter your email.",
  NetworkError: "You're offline. Check your connection and try again.",
  InvalidPasswordException: "Choose a password of at least 8 characters.",
  CodeMismatchException: "That code isn't right. Check the email and try again.",
  ExpiredCodeException: "That code has expired. Send a new one.",
};

/** Cognito refuses a password with a space at either end this way (its own pattern check). */
const SPACES = "Passwords can't start or end with a space.";

/** Per-action overrides of `ERROR_MESSAGES`. */
const ACTION_MESSAGES: Partial<Record<AuthAction, Record<string, string>>> = {
  newPassword: { InvalidParameterException: SPACES },
  confirmReset: { InvalidParameterException: SPACES },
  requestReset: {
    // Still on the temporary password (an invitation not yet used).
    NotAuthorizedException:
      "You haven't chosen a password yet. Sign in with the temporary password from your invitation email.",
    InvalidParameterException:
      "There's no verified email on this account to send a code to. Ask your administrator to reset your password.",
  },
  change: {
    NotAuthorizedException: "Your current password is incorrect.",
    InvalidParameterException: SPACES,
  },
};

const FALLBACK: Record<AuthAction, string> = {
  signIn: "Couldn't sign in. Please try again.",
  newPassword: "Couldn't set your password. Please try again.",
  requestReset: "Couldn't send the code. Please try again.",
  confirmReset: "Couldn't reset your password. Please try again.",
  change: "Couldn't change your password. Please try again.",
};

/** A user-facing message for a Cognito/Amplify error during `action`. */
export function authErrorMessage(err: unknown, action: AuthAction = "signIn"): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  // Cognito's 7-day limit on the emailed temporary password.
  if (name === "NotAuthorizedException" && /temporary password has expired/i.test(message)) {
    return "Your invitation has expired. Ask whoever invited you to invite you again: you'll get a new email.";
  }
  return ACTION_MESSAGES[action]?.[name] ?? ERROR_MESSAGES[name] ?? FALLBACK[action];
}

/** Cognito's 3-minute challenge session ran out (or the page forgot it). */
function isExpiredChallenge(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "SignInException") return true; // Amplify: no sign-in in progress any more
  return err.name === "NotAuthorizedException" && /session/i.test(err.message);
}

export const MIN_PASSWORD_LENGTH = 8;
/** Cognito's own limit. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Why `password` would be refused, checked before asking Cognito (the pool
 * wants 8+ characters and no leading or trailing whitespace), or `null`.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim() !== password) return "Passwords can't start or end with a space.";
  return null;
}

/**
 * What signing in needs next: done, or a new password (invited guests sign in
 * first with the temporary password Cognito emailed them).
 */
export type SignInResult = { user: SessionUser } | { newPasswordRequired: true };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  let result: Awaited<ReturnType<typeof amplifySignIn>> | undefined;
  try {
    result = await amplifySignIn({ username: usernameOf(email), password });
  } catch (err) {
    // Already signed in (e.g. in another tab): reuse that session.
    if (!(err instanceof Error && err.name === "UserAlreadyAuthenticatedException")) {
      throw new Error(authErrorMessage(err, "signIn"), { cause: err });
    }
  }
  if (result && !result.isSignedIn) {
    if (result.nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
      return { newPasswordRequired: true };
    }
    throw new Error("This sign-in needs an extra step the app doesn't support yet.");
  }
  return { user: await sessionUser() };
}

/**
 * Second step of a first sign-in: replaces the temporary password. Throws
 * `ChallengeExpiredError` when it took too long: sign in again from the start.
 */
export async function setNewPassword(password: string): Promise<SessionUser> {
  let result: Awaited<ReturnType<typeof confirmSignIn>>;
  try {
    result = await confirmSignIn({ challengeResponse: password });
  } catch (err) {
    if (isExpiredChallenge(err)) {
      throw new ChallengeExpiredError(
        "That took too long. Sign in again with your temporary password.",
        { cause: err },
      );
    }
    throw new Error(authErrorMessage(err, "newPassword"), { cause: err });
  }
  if (!result.isSignedIn) throw new Error("Couldn't finish signing in. Please try again.");
  return sessionUser();
}

/**
 * "Forgot password?": Cognito emails a code. Returns where it went (masked,
 * e.g. `c***@m***`) when Cognito says. Unknown emails look the same as known
 * ones (the pool hides which accounts exist).
 */
export async function requestPasswordReset(email: string): Promise<string | null> {
  try {
    const result = await resetPassword({ username: usernameOf(email) });
    return result.nextStep.codeDeliveryDetails?.destination ?? null;
  } catch (err) {
    throw new Error(authErrorMessage(err, "requestReset"), { cause: err });
  }
}

/** Sets a new password with the emailed code, then signs in with it. */
export async function confirmPasswordReset(
  email: string,
  code: string,
  password: string,
): Promise<SignInResult> {
  try {
    await confirmResetPassword({
      username: usernameOf(email),
      confirmationCode: code.trim(),
      newPassword: password,
    });
  } catch (err) {
    throw new Error(authErrorMessage(err, "confirmReset"), { cause: err });
  }
  return signIn(email, password);
}

/** Settings: a signed-in user changes their password (Cognito wants the current one). */
export async function changePassword(current: string, next: string): Promise<void> {
  try {
    await updatePassword({ oldPassword: current, newPassword: next });
  } catch (err) {
    throw new Error(authErrorMessage(err, "change"), { cause: err });
  }
}

async function sessionUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Couldn't read your session. Please try again.");
  return user;
}

export async function signOut(): Promise<void> {
  await amplifySignOut();
}
