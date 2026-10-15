import { roleFromGroups, type Role } from "@mindfultech/shared";
import { Amplify } from "aws-amplify";
import {
  confirmSignIn,
  fetchAuthSession,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
} from "aws-amplify/auth";

export interface SessionUser {
  userId: string;
  email: string;
  /** From the id token's Cognito groups (the server enforces it; the UI follows it). */
  role: Role;
}

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

const ERROR_MESSAGES: Record<string, string> = {
  NotAuthorizedException: "Incorrect email or password.",
  UserNotFoundException: "Incorrect email or password.",
  UserNotConfirmedException: "Your account is not confirmed yet. Contact your administrator.",
  PasswordResetRequiredException: "You need to reset your password. Contact your administrator.",
  LimitExceededException: "Too many attempts. Wait a moment and try again.",
  TooManyRequestsException: "Too many attempts. Wait a moment and try again.",
  EmptySignInUsername: "Enter your email.",
  EmptySignInPassword: "Enter your password.",
  NetworkError: "You're offline. Check your connection and try again.",
  InvalidPasswordException: "Choose a password of at least 8 characters.",
};

/** Spanish message for a Cognito/Amplify sign-in error. */
export function authErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return ERROR_MESSAGES[name] ?? "Couldn't sign in. Please try again.";
}

/**
 * What signing in needs next: done, or a new password (invited guests sign in
 * first with the temporary password Cognito emailed them).
 */
export type SignInResult = { user: SessionUser } | { newPasswordRequired: true };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  let result: Awaited<ReturnType<typeof amplifySignIn>> | undefined;
  try {
    result = await amplifySignIn({ username: email.trim().toLowerCase(), password });
  } catch (err) {
    // Already signed in (e.g. in another tab): reuse that session.
    if (!(err instanceof Error && err.name === "UserAlreadyAuthenticatedException")) {
      throw new Error(authErrorMessage(err), { cause: err });
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

/** Second step of a first sign-in: replaces the temporary password. */
export async function setNewPassword(password: string): Promise<SessionUser> {
  let result: Awaited<ReturnType<typeof confirmSignIn>>;
  try {
    result = await confirmSignIn({ challengeResponse: password });
  } catch (err) {
    throw new Error(authErrorMessage(err), { cause: err });
  }
  if (!result.isSignedIn) throw new Error("Couldn't finish signing in. Please try again.");
  return sessionUser();
}

async function sessionUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Couldn't read your session. Please try again.");
  return user;
}

export async function signOut(): Promise<void> {
  await amplifySignOut();
}
