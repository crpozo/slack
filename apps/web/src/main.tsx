import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CallPipPage } from "./components/CallPipPage";
import { PIP_PATH } from "./lib/pipTauri";
import { configureAuth } from "./lib/auth";
import { registerServiceWorker } from "./lib/push";
import { loadConfig } from "./lib/config";
import { installAudioUnlock } from "./lib/sounds";
import { configureTasksApi } from "./lib/tasksApi";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { installExternalLinks } from "./lib/external";
import { useChat } from "./store";
import "./styles.css";

// index.html already applied the saved theme before paint; keep it in sync with the OS.
applyTheme();
watchSystemTheme();
// Browsers block audio until a user gesture: arm notification sounds on the first one.
installAudioUnlock();
// Desktop app: links to other sites open in the OS's browser, never inside the app.
installExternalLinks((message) => useChat.getState().showToast(message));

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");
const root = createRoot(rootElement);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

if (location.pathname === PIP_PATH) {
  // The desktop app's small call window: fed by the main window over Tauri
  // events, so it needs neither the config nor a session of its own.
  render(<CallPipPage />);
} else {
  try {
    const config = await loadConfig();
    configureAuth(config.userPoolId, config.userPoolClientId);
    configureTasksApi(config.tasksUrl ?? null);
    render(<App config={config} />);
    // Notifications and their clicks go through the service worker; registering never blocks the app.
    void registerServiceWorker();
  } catch (err: unknown) {
    render(
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-ink">
          Incomplete configuration: {err instanceof Error ? err.message : String(err)}
        </p>
      </div>,
    );
  }
}
