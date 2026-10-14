import { assertWebSocketUrl } from "./ws";

export interface DirectoryUser {
  email: string;
  /** Cognito `sub`; unknown until configured or seen in a message. */
  userId?: string;
}

export interface AppConfig {
  wsUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  users: DirectoryUser[];
  /** Task Manager HTTP API; absent on deployments without it. */
  tasksUrl?: string;
}

/** Shape of `/config.json`, written by CDK next to index.html on every deploy. */
interface RuntimeConfig {
  wsUrl?: unknown;
  userPoolId?: unknown;
  userPoolClientId?: unknown;
  users?: unknown;
  tasksUrl?: unknown;
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

/** `https://` anywhere, `http://` only on localhost; no credentials, query or fragment. */
export function assertHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid API URL: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`The API URL must use https:// (http:// only on localhost): ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`The API URL can't include credentials, a query or a fragment: ${raw}`);
  }
  return url.href.replace(/\/$/, "");
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Merges the deployed `/config.json` (wins) with the build-time `VITE_*` values
 * (local development). Throws with the missing keys if neither provides them.
 */
export function resolveConfig(
  runtime: RuntimeConfig | null,
  env: Partial<ImportMetaEnv>,
): AppConfig {
  const wsUrl = str(runtime?.wsUrl) ?? str(env.VITE_WS_URL);
  const userPoolId = str(runtime?.userPoolId) ?? str(env.VITE_COGNITO_USER_POOL_ID);
  const userPoolClientId = str(runtime?.userPoolClientId) ?? str(env.VITE_COGNITO_CLIENT_ID);

  const missing = [
    !wsUrl && "VITE_WS_URL",
    !userPoolId && "VITE_COGNITO_USER_POOL_ID",
    !userPoolClientId && "VITE_COGNITO_CLIENT_ID",
  ].filter(Boolean);
  if (!wsUrl || !userPoolId || !userPoolClientId) {
    throw new Error(`Missing ${missing.join(", ")} in apps/web/.env or /config.json`);
  }

  const tasksUrl = str(runtime?.tasksUrl) ?? str(env.VITE_TASKS_URL);
  return {
    wsUrl: assertWebSocketUrl(wsUrl),
    userPoolId,
    userPoolClientId,
    users: parseUsers(str(runtime?.users) ?? env.VITE_USERS),
    ...(tasksUrl ? { tasksUrl: assertHttpUrl(tasksUrl) } : {}),
  };
}

/** `/config.json` if the host serves one (CloudFront), `null` otherwise (Vite dev). */
async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    // index.html starts this request before the bundle loads: one round trip saved.
    const early = (window as Window & { __configRequest?: Promise<Response> }).__configRequest;
    const res = await (early ?? fetch("/config.json", { cache: "no-store" }));
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as RuntimeConfig) : null;
  } catch {
    return null;
  }
}

export async function loadConfig(): Promise<AppConfig> {
  return resolveConfig(await fetchRuntimeConfig(), import.meta.env);
}
