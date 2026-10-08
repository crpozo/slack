import { GENERAL_CHANNEL_ID } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ChatLayout } from "./components/ChatLayout";
import { LoginPage, Logo } from "./components/LoginPage";
import { getCurrentUser } from "./lib/auth";
import type { AppConfig } from "./lib/config";
import { useChat } from "./store";

const HOME = `/app/${GENERAL_CHANNEL_ID}`;

export default function App({ config }: { config: AppConfig }) {
  const me = useChat((s) => s.me);
  const [checked, setChecked] = useState(false);

  // Restore a persisted Cognito session (Amplify refreshes tokens on its own).
  useEffect(() => {
    void getCurrentUser().then((user) => {
      useChat.getState().setSession(user, config.users);
      setChecked(true);
    });
  }, [config.users]);

  if (!checked) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-sidebar">
        <div className="animate-pulse">
          <Logo />
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            me ? (
              <Navigate to={HOME} replace />
            ) : (
              <LoginPage onSignedIn={(user) => useChat.getState().setSession(user, config.users)} />
            )
          }
        />
        <Route
          path="/app/:channelId"
          element={me ? <ChatLayout wsUrl={config.wsUrl} /> : <Navigate to="/login" replace />}
        />
        <Route path="*" element={<Navigate to={me ? HOME : "/login"} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
