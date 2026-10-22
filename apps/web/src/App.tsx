import { GENERAL_CHANNEL_ID } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ChatLayout } from "./components/ChatLayout";
import { GuestLayout } from "./components/GuestLayout";
import { LoginPage, Logo } from "./components/LoginPage";
import { getCurrentUser } from "./lib/auth";
import type { AppConfig } from "./lib/config";
import { MOBILE_QUERY } from "./lib/hooks";
import { loadSessionSnapshot, saveSessionSnapshot } from "./lib/session";
import { MOBILE_HOME } from "./components/MobileScreens";
import { useChat } from "./store";

/** Phones open on the Home tab; desktop on #general. */
const HOME = window.matchMedia(MOBILE_QUERY).matches ? MOBILE_HOME : `/app/${GENERAL_CHANNEL_ID}`;

export default function App({ config }: Readonly<{ config: AppConfig }>) {
  const me = useChat((s) => s.me);
  const [checked, setChecked] = useState(false);

  // Paint for the last signed-in person at once (from the session snapshot),
  // while Amplify verifies the session in the background; a dead one signs out.
  useEffect(() => {
    const remembered = loadSessionSnapshot();
    if (remembered) {
      useChat.getState().setSession(remembered, config.users);
      setChecked(true);
    }
    void getCurrentUser().then((user) => {
      saveSessionSnapshot(user);
      const current = useChat.getState().me;
      if (!user) {
        if (current) useChat.getState().setSession(null);
      } else if (!current || current.userId !== user.userId) {
        useChat.getState().setSession(user, config.users);
      } else if (current.role !== user.role) {
        // Same person, a role change since last time: refresh without losing the cache.
        useChat.setState({ me: user });
      }
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

  // Guests (external clients) get the boards they're invited to and nothing else.
  if (me?.role === "guest") {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/app/tasks/:boardId?" element={<GuestLayout wsUrl={config.wsUrl} />} />
          <Route path="*" element={<Navigate to="/app/tasks" replace />} />
        </Routes>
      </BrowserRouter>
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
              <LoginPage
                onSignedIn={(user) => {
                  saveSessionSnapshot(user);
                  useChat.getState().setSession(user, config.users);
                }}
              />
            )
          }
        />
        <Route
          path="/app/tasks/:boardId?"
          element={me ? <ChatLayout wsUrl={config.wsUrl} /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/app/calendar"
          element={me ? <ChatLayout wsUrl={config.wsUrl} /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/app/notes"
          element={me ? <ChatLayout wsUrl={config.wsUrl} /> : <Navigate to="/login" replace />}
        />
        {["/app/home", "/app/dms", "/app/activity", "/app/search"].map((path) => (
          <Route
            key={path}
            path={path}
            element={me ? <ChatLayout wsUrl={config.wsUrl} /> : <Navigate to="/login" replace />}
          />
        ))}
        <Route
          path="/app/:channelId/thread/:messageId"
          element={me ? <ChatLayout wsUrl={config.wsUrl} /> : <Navigate to="/login" replace />}
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
