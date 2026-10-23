/**
 * Unsent composer text, per conversation, in `localStorage`: switching away
 * (or reloading, or the desktop app restarting) keeps what you were typing.
 *
 * Keys are per signed-in user (a shared computer never shows one person's
 * draft to another) and per composer: a channel or DM has one, and each
 * thread has its own (`…#thread:<parentSk>`), so a half-written reply never
 * lands in the channel's input or the other way round.
 *
 * Storage can be missing, full or blocked (private windows, quota, a policy):
 * every access is wrapped, and a draft that can't be kept just isn't.
 */

const PREFIX = "mt.draft:";
/** Typing saves this long after the last keystroke. */
export const DRAFT_SAVE_DELAY_MS = 400;

/** Where the draft of a conversation's composer (or of one of its threads) lives. */
export function draftKey(userId: string, channelId: string, threadSk?: string): string {
  return `${PREFIX}${userId}:${channelId}${threadSk ? `#thread:${threadSk}` : ""}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some browsers throw on the mere access when site data is blocked.
    return null;
  }
}

export function loadDraft(key: string): string {
  try {
    return storage()?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Saves `text`, or forgets the draft when there's nothing left in it. */
export function saveDraft(key: string, text: string): void {
  try {
    if (text.trim()) storage()?.setItem(key, text);
    else storage()?.removeItem(key);
  } catch {
    // Full or blocked: the draft lives only as long as the composer does.
  }
}

export function clearDraft(key: string): void {
  saveDraft(key, "");
}

/** Sign-out: every draft of `userId` goes with the rest of their data on this device. */
export function clearDrafts(userId: string): void {
  const store = storage();
  if (!store) return;
  try {
    const mine = `${PREFIX}${userId}:`;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(mine)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing more to do: the browser won't let us read or write its storage.
  }
}

/**
 * Debounced saves for one composer. An emptied input is forgotten at once (a
 * sent or cleared message must not come back on the next visit); `flush`
 * writes a pending save now, for unmounting and for the page going away.
 */
export function createDraftSaver(key: string, delayMs = DRAFT_SAVE_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending !== undefined) saveDraft(key, pending);
    pending = undefined;
  };

  return {
    schedule(text: string) {
      pending = text;
      if (!text.trim()) return flush();
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    /** Drops a pending save without writing it (the text isn't a draft after all). */
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
    flush,
  };
}
