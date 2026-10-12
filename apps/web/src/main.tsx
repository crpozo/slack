import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { configureAuth } from "./lib/auth";
import { loadConfig } from "./lib/config";
import { installAudioUnlock } from "./lib/sounds";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import "./styles.css";

// index.html already applied the saved theme before paint; keep it in sync with the OS.
applyTheme();
watchSystemTheme();
// Browsers block audio until a user gesture: arm notification sounds on the first one.
installAudioUnlock();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");
const root = createRoot(rootElement);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

try {
  const config = await loadConfig();
  configureAuth(config.userPoolId, config.userPoolClientId);
  render(<App config={config} />);
} catch (err: unknown) {
  render(
    <div className="flex h-full items-center justify-center p-6">
      <p className="max-w-md rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-ink">
        Incomplete configuration: {err instanceof Error ? err.message : String(err)}
      </p>
    </div>,
  );
}
