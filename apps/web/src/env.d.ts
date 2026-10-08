/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL: string;
  readonly VITE_COGNITO_USER_POOL_ID: string;
  readonly VITE_COGNITO_CLIENT_ID: string;
  /** Comma-separated team directory: `email` or `email=cognitoSub`. */
  readonly VITE_USERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
