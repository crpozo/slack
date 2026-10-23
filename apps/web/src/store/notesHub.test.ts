import type { AiNotes, Message, NotesPage } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import { createNotesHub } from "./notesHub";

const card = (sk: string, patch: Partial<Message> = {}): Message => ({
  messageId: `m-${sk}`,
  channelId: "dm_a_b",
  sk,
  userId: "a",
  userEmail: "a@x.ec",
  text: "✨ AI call notes",
  attachments: [],
  createdAt: Number(sk.split("#")[0]),
  reactions: {},
  kind: "ai_notes",
  aiNotes: {
    callId: sk,
    status: "pending",
    summary: "",
    startedAt: 0,
    endedAt: 1,
    participants: ["a", "b"],
  },
  ...patch,
});

function setup() {
  const pages: Array<(value: NotesPage | Error) => void> = [];
  const list = vi.fn(
    () =>
      new Promise<NotesPage>((resolve, reject) =>
        pages.push((v) => (v instanceof Error ? reject(v) : resolve(v))),
      ),
  );
  const hub = createNotesHub({ list });
  const answer = async (value: NotesPage | Error) => {
    pages.shift()?.(value);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { hub, list, answer };
}

describe("AI Notes hub store", () => {
  it("loads the first page, then older pages after it, skipping repeats", async () => {
    const { hub, list, answer } = setup();
    void hub.getState().load();
    expect(hub.getState().status).toBe("loading");
    await answer({ notes: [card("3#c"), card("2#b")], nextCursor: "cur-1" });
    expect(hub.getState()).toMatchObject({ status: "ready", nextCursor: "cur-1" });

    void hub.getState().loadMore();
    void hub.getState().loadMore(); // already loading: ignored
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith("cur-1");
    await answer({ notes: [card("2#b"), card("1#a")], nextCursor: null });
    expect(hub.getState().notes.map((m) => m.sk)).toEqual(["3#c", "2#b", "1#a"]);
    expect(hub.getState().nextCursor).toBeNull();
    void hub.getState().loadMore(); // last page: nothing to ask
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("puts new cards in time order and applies updates, once loaded", async () => {
    const { hub, answer } = setup();
    hub.getState().upsert(card("9#z")); // not loaded yet: the load will bring it
    expect(hub.getState().notes).toEqual([]);
    void hub.getState().load();
    await answer({ notes: [card("3#c"), card("1#a")], nextCursor: null });

    hub.getState().upsert(card("4#d"));
    hub.getState().upsert(card("2#b"));
    hub.getState().upsert({ ...card("5#e"), kind: undefined }); // not a notes card
    expect(hub.getState().notes.map((m) => m.sk)).toEqual(["4#d", "3#c", "2#b", "1#a"]);

    const ready: AiNotes = { ...card("3#c").aiNotes!, status: "ready", summary: "Hi" };
    hub.getState().update("dm_a_b", "3#c", ready, "✨ AI call notes: Hi");
    expect(hub.getState().notes[1]).toMatchObject({ aiNotes: ready, text: "✨ AI call notes: Hi" });
    hub.getState().update("dm_a_b", "nope", ready, "x"); // unknown: ignored
  });

  it("reports a failed load, keeps loaded notes on a failed older page, and drops answers after a reset", async () => {
    const { hub, answer } = setup();
    void hub.getState().load();
    await answer(new Error("Couldn't reach the server."));
    expect(hub.getState()).toMatchObject({ status: "error", error: "Couldn't reach the server." });

    void hub.getState().load();
    await answer({ notes: [card("2#b")], nextCursor: "c" });
    void hub.getState().loadMore();
    await answer(new Error("Request failed (500)"));
    expect(hub.getState()).toMatchObject({ status: "ready", loadingMore: false });
    expect(hub.getState().notes).toHaveLength(1);

    void hub.getState().load();
    hub.getState().reset(); // signed out meanwhile
    await answer({ notes: [card("7#x")], nextCursor: null });
    expect(hub.getState()).toMatchObject({ status: "idle", notes: [] });
  });
});

describe("AI Notes hub: deleted cards (Phase 32)", () => {
  it("drops a deleted card", async () => {
    const { hub, answer } = setup();
    void hub.getState().load();
    await answer({ notes: [card("3#c"), card("2#b")], nextCursor: null });
    hub.getState().remove("dm_a_b", "3#c");
    hub.getState().remove("dm_a_b", "nope");
    expect(hub.getState().notes.map((m) => m.sk)).toEqual(["2#b"]);
  });
});
