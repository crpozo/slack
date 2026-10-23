import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  clearDrafts,
  createDraftSaver,
  draftKey,
  DRAFT_SAVE_DELAY_MS,
  loadDraft,
  saveDraft,
} from "./drafts";

/** A Map-backed `Storage`, enough for what drafts use. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("draft keys", () => {
  it("are per user and per composer, a thread apart from its channel", () => {
    const channel = draftKey("u1", "ch_general");
    const thread = draftKey("u1", "ch_general", "1700000000000#P");
    expect(
      new Set([channel, thread, draftKey("u2", "ch_general"), draftKey("u1", "dm_a_b")]).size,
    ).toBe(4);
    saveDraft(thread, "reply");
    expect(loadDraft(channel)).toBe("");
    expect(loadDraft(thread)).toBe("reply");
  });
});

describe("drafts", () => {
  const key = draftKey("u1", "ch_general");

  it("keep text and forget an empty (or blank) input", () => {
    saveDraft(key, "hola\nqué tal");
    expect(loadDraft(key)).toBe("hola\nqué tal");
    saveDraft(key, "   ");
    expect(storage.getItem(key)).toBeNull();
    saveDraft(key, "again");
    clearDraft(key);
    expect(loadDraft(key)).toBe("");
  });

  it("degrade to nothing when storage throws or is missing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => saveDraft(key, "x")).not.toThrow();
    expect(loadDraft(key)).toBe("");
    vi.stubGlobal("localStorage", undefined);
    expect(() => saveDraft(key, "x")).not.toThrow();
    expect(loadDraft(key)).toBe("");
    expect(() => clearDrafts("u1")).not.toThrow();
  });

  it("are all removed on sign-out, other people's left alone", () => {
    saveDraft(draftKey("u1", "ch_general"), "a");
    saveDraft(draftKey("u1", "ch_general", "1#P"), "b");
    saveDraft(draftKey("u2", "ch_general"), "c");
    storage.setItem("theme", "dark");
    clearDrafts("u1");
    expect(loadDraft(draftKey("u1", "ch_general"))).toBe("");
    expect(loadDraft(draftKey("u1", "ch_general", "1#P"))).toBe("");
    expect(loadDraft(draftKey("u2", "ch_general"))).toBe("c");
    expect(storage.getItem("theme")).toBe("dark");
  });
});

describe("createDraftSaver", () => {
  const key = draftKey("u1", "ch_general");

  it("saves once typing pauses, not on every keystroke", () => {
    vi.useFakeTimers();
    const saver = createDraftSaver(key);
    saver.schedule("h");
    saver.schedule("ho");
    saver.schedule("hol");
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 1);
    expect(loadDraft(key)).toBe("");
    vi.advanceTimersByTime(1);
    expect(loadDraft(key)).toBe("hol");
  });

  it("forgets the draft at once when the input is emptied (sent or cleared)", () => {
    vi.useFakeTimers();
    saveDraft(key, "old");
    const saver = createDraftSaver(key);
    saver.schedule("typing");
    saver.schedule("");
    expect(loadDraft(key)).toBe("");
    vi.runAllTimers();
    expect(loadDraft(key)).toBe(""); // the pending "typing" never lands afterwards
  });

  it("writes a pending save on flush (leaving the conversation) and drops it on cancel", () => {
    vi.useFakeTimers();
    const saver = createDraftSaver(key);
    saver.schedule("half a thought");
    saver.flush();
    expect(loadDraft(key)).toBe("half a thought");
    saver.schedule("secret stuff");
    saver.cancel();
    vi.runAllTimers();
    expect(loadDraft(key)).toBe("half a thought");
  });
});
