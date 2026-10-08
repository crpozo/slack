import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { configureAuth } from "./lib/auth";
import { loadConfig, type AppConfig } from "./lib/config";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

let config: AppConfig | null = null;
let configError = "";
try {
  config = loadConfig();
  configureAuth(config.userPoolId, config.userPoolClientId);
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
}

createRoot(root).render(
  <StrictMode>
    {config ? (
      <App config={config} />
    ) : (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-ink">
          Configuración incompleta: {configError}
        </p>
      </div>
    )}
  </StrictMode>,
);
