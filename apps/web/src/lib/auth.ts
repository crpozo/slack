import { Amplify } from "aws-amplify";
import {
  fetchAuthSession,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
} from "aws-amplify/auth";

export interface SessionUser {
  userId: string;
  email: string;
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
    return { userId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

/** Fresh id token for the WebSocket handshake. */
export async function getIdToken(): Promise<string> {
  const token = (await fetchAuthSession()).tokens?.idToken?.toString();
  if (!token) throw new SessionExpiredError("No hay sesión activa");
  return token;
}

const ERROR_MESSAGES: Record<string, string> = {
  NotAuthorizedException: "Email o contraseña incorrectos.",
  UserNotFoundException: "Email o contraseña incorrectos.",
  UserNotConfirmedException: "Tu cuenta aún no está confirmada. Contacta al administrador.",
  PasswordResetRequiredException: "Debes restablecer tu contraseña. Contacta al administrador.",
  LimitExceededException: "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
  TooManyRequestsException: "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
  EmptySignInUsername: "Ingresa tu email.",
  EmptySignInPassword: "Ingresa tu contraseña.",
  NetworkError: "Sin conexión. Revisa tu red e inténtalo de nuevo.",
};

/** Spanish message for a Cognito/Amplify sign-in error. */
export function authErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return ERROR_MESSAGES[name] ?? "No se pudo iniciar sesión. Inténtalo de nuevo.";
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
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
    throw new Error(
      result.nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
        ? "Tu contraseña es temporal. Pide al administrador que la marque como permanente."
        : "Este inicio de sesión requiere un paso adicional que la app aún no soporta.",
    );
  }
  const user = await getCurrentUser();
  if (!user) throw new Error("No se pudo leer la sesión. Inténtalo de nuevo.");
  return user;
}

export async function signOut(): Promise<void> {
  await amplifySignOut();
}
