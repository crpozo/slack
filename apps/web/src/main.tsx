import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { configureAuth } from "./lib/auth";
import { loadConfig } from "./lib/config";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");
const root = createRoot(rootElement);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

loadConfig().then(
  (config) => {
    configureAuth(config.userPoolId, config.userPoolClientId);
    render(<App config={config} />);
  },
  (err: unknown) =>
    render(
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-ink">
          Configuración incompleta: {err instanceof Error ? err.message : String(err)}
        </p>
      </div>,
    ),
);
