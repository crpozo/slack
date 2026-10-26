import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useMatch } from "react-router-dom";
import { signOut } from "../lib/auth";
import { chat } from "../lib/chat";
import { signOutPush, syncPush } from "../lib/push";
import { useChat } from "../store";
import { useTasks } from "../store/tasks";
import { LockIcon, LogOutIcon } from "./icons";
import { Logo } from "./LoginPage";
import { NotificationBell } from "./NotificationBell";
import { PushPrompt } from "./PushPrompt";
import { Toast } from "./Toast";

const TaskManager = lazy(() => import("./TaskManager").then((m) => ({ default: m.TaskManager })));
const PasswordModal = lazy(() =>
  Promise.all([import("./Modal"), import("./ChangePasswordForm")]).then(([m, f]) => ({
    default: ({ onClose }: Readonly<{ onClose: () => void }>) => (
      <m.Modal title="Change password" onClose={onClose}>
        <f.ChangePasswordForm />
      </m.Modal>
    ),
  })),
);

const iconButton = "rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink";

/**
 * What a guest (an external client) sees: the boards they were invited to,
 * and nothing of the team's chat — no channels, DMs, calls or settings
 * (except their own password). The
 * server enforces the same (route guards and the delivery filter); this is
 * only the matching UI.
 */
export function GuestLayout({ wsUrl }: Readonly<{ wsUrl: string }>) {
  const boardId = useMatch("/app/tasks/:boardId?")?.params.boardId;
  const me = useChat((s) => s.me);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const handleSignOut = useCallback(async () => {
    await signOutPush();
    chat.stop();
    useTasks.getState().reset();
    await signOut().catch(() => {});
    useChat.getState().setSession(null);
  }, []);

  // The socket carries live board updates (and the board members' names).
  useEffect(() => {
    chat.start(wsUrl, () => {
      useChat.getState().showToast("Your session expired. Please sign in again.");
      void handleSignOut();
    });
    return () => chat.stop();
  }, [wsUrl, handleSignOut]);

  useEffect(() => {
    if (me) void syncPush(me.userId);
  }, [me]);

  useEffect(() => {
    document.title = "MindfulTech · Boards";
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface pb-[env(safe-area-inset-bottom)]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface-sidebar px-3 pt-[env(safe-area-inset-top)] sm:px-4">
        <Logo />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">MindfulTech</p>
          <p className="truncate text-xs text-ink-secondary">Guest access · {me?.email}</p>
        </div>
        <NotificationBell className={iconButton} />
        <button
          type="button"
          onClick={() => setPasswordOpen(true)}
          className={iconButton}
          aria-label="Change password"
          title="Change password"
        >
          <LockIcon />
        </button>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className={iconButton}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOutIcon />
        </button>
      </header>
      <main className="flex min-h-0 w-full flex-1 flex-col">
        <PushPrompt />
        <Suspense
          fallback={<div className="flex-1" aria-busy="true" aria-label="Loading boards" />}
        >
          <TaskManager boardId={boardId} />
        </Suspense>
      </main>
      {passwordOpen && (
        <Suspense fallback={null}>
          <PasswordModal onClose={() => setPasswordOpen(false)} />
        </Suspense>
      )}
      <Toast />
    </div>
  );
}
