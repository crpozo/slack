export interface DirectoryUser {
  email: string;
  /** Cognito `sub`; unknown until configured or seen in a message. */
  userId?: string;
}

function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value) throw new Error(`Falta ${name} en apps/web/.env (ver .env.example)`);
  return value;
}

/** Parses `VITE_USERS`: comma-separated `email` or `email=sub` entries. */
export function parseUsers(raw: string | undefined): DirectoryUser[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [email = "", userId] = entry.split("=").map((s) => s.trim());
      const validId =
        userId && !userId.startsWith("<") && !userId.includes("_") ? userId : undefined;
      return { email: email.toLowerCase(), userId: validId };
    })
    .filter((u) => u.email.includes("@"));
}

export function loadConfig() {
  return {
    wsUrl: required("VITE_WS_URL"),
    userPoolId: required("VITE_COGNITO_USER_POOL_ID"),
    userPoolClientId: required("VITE_COGNITO_CLIENT_ID"),
    users: parseUsers(import.meta.env.VITE_USERS),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
