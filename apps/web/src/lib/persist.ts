import { clearSnapshot, createPersister, loadSnapshot, snapshotOf } from "./cache";
import { clearDrafts } from "./drafts";
import { useChat } from "../store";

/**
 * Keeps the offline cache in step with the store for the signed-in user:
 * hydrates the store from the last snapshot (the shell paints from it at
 * once), then writes a fresh snapshot, debounced, whenever what it holds
 * changes. Returns a function that stops the writes (sign-out, unmount).
 */
export function startPersistence(userId: string): () => void {
  let stopped = false;
  const store = useChat;
  void loadSnapshot(userId).then((snapshot) => {
    if (stopped) return;
    // Still the same person? (A quick sign-out/in could swap them.)
    if (store.getState().me?.userId === userId) store.getState().hydrate(snapshot);
  });

  const persister = createPersister(userId, () => snapshotOf(store.getState()));
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.channels !== previous.channels ||
      state.pinned !== previous.pinned ||
      state.users !== previous.users ||
      state.directory !== previous.directory ||
      state.messagesByChannel !== previous.messagesByChannel ||
      state.cursors !== previous.cursors ||
      state.reads !== previous.reads
    ) {
      persister.schedule();
    }
  });
  return () => {
    stopped = true;
    persister.stop();
    unsubscribe();
  };
}

/** Sign-out: nothing of this person stays on the device. */
export function forgetPersisted(userId: string): Promise<void> {
  clearDrafts(userId);
  return clearSnapshot(userId);
}
