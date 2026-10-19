import { describe, expect, it } from "vitest";
import {
  countUnreadAfter,
  isGroupedWith,
  mergeMessages,
  pendingMessageId,
  type ChatMessage,
} from "./messages";

const msg = (n: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${n}`,
  channelId: "ch_general",
  sk: `${1_700_000_000_000 + n}#X`,
  userId: "alice",
  userEmail: "alice@example.com",
  text: `t${n}`,
  attachments: [],
  createdAt: 1_700_000_000_000 + n,
  ...extra,
});

describe("mergeMessages", () => {
  it("dedupes and sorts chronologically", () => {
    const merged = mergeMessages([msg(3), msg(1)], [msg(2), msg(3)]);
    expect(merged.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  it("replaces an optimistic message once the server confirms it", () => {
    const pending = msg(0, {
      messageId: pendingMessageId("c1"),
      clientId: "c1",
      status: "pending",
      sk: "",
    });
    const merged = mergeMessages([msg(1), pending], [msg(5, { clientId: "c1" })]);
    expect(merged.map((m) => m.messageId)).toEqual(["m1", "m5"]);
  });

  it("keeps pending messages after confirmed ones", () => {
    const pending = msg(0, { messageId: "pending:c2", clientId: "c2", status: "failed", sk: "" });
    expect(mergeMessages([pending], [msg(9)]).map((m) => m.messageId)).toEqual([
      "m9",
      "pending:c2",
    ]);
  });
});

describe("countUnreadAfter", () => {
  it("counts other people's confirmed messages after the mark, back to your own latest", () => {
    const messages = [
      msg(1, { userId: "bob" }),
      msg(2, { userId: "me" }),
      msg(3, { userId: "bob" }),
      msg(4, { userId: "bob" }),
      msg(5, { userId: "bob", status: "pending" }),
    ];
    expect(countUnreadAfter(messages, msg(3).sk, "me")).toBe(1);
    expect(countUnreadAfter(messages, "0", "me")).toBe(2); // stops at "me"
    expect(countUnreadAfter(messages, msg(4).sk, "me")).toBe(0);
  });
});

describe("store: unread counts", async () => {
  const { useChat, selectUnread } = await import("./index");
  const general = {
    channelId: "ch_general",
    name: "general",
    type: "public" as const,
    createdBy: "system",
    createdAt: 1,
    archived: false,
  };

  it("starts from the server's counts, bumps, and clears when viewed", () => {
    useChat.getState().setSession({ userId: "me", email: "me@mt.ec", role: "member" });
    useChat.getState().setChannels([general], { ch_general: 3 });
    expect(selectUnread(useChat.getState(), "ch_general")).toBe(3);

    useChat.getState().bumpUnread("ch_general", true);
    expect(selectUnread(useChat.getState(), "ch_general")).toBe(4);
    expect(useChat.getState().mentioned.ch_general).toBe(true);

    // A broadcast list (no counts) keeps ours.
    useChat.getState().setChannels([general]);
    expect(selectUnread(useChat.getState(), "ch_general")).toBe(4);

    useChat.getState().markRead("ch_general");
    expect(selectUnread(useChat.getState(), "ch_general")).toBe(0);
    expect(useChat.getState().mentioned.ch_general).toBeUndefined();
  });

  it("recounts from a read mark set on another device, never upwards", () => {
    useChat.getState().setSession({ userId: "me", email: "me@mt.ec", role: "member" });
    useChat.getState().setChannels([general], { ch_general: 5 });
    useChat
      .getState()
      .receiveHistory("ch_general", [msg(1, { userId: "bob" }), msg(2, { userId: "bob" })], null);

    useChat.getState().recountUnread("ch_general", msg(1).sk);
    expect(selectUnread(useChat.getState(), "ch_general")).toBe(1);
    useChat.getState().recountUnread("ch_general", msg(2).sk);
    expect(selectUnread(useChat.getState(), "ch_general")).toBe(0);
  });
});

describe("isGroupedWith", () => {
  it("groups the same author within 5 minutes", () => {
    expect(isGroupedWith(msg(0), msg(60_000))).toBe(true);
    expect(isGroupedWith(msg(0), msg(6 * 60_000))).toBe(false);
    expect(isGroupedWith(msg(0), msg(1, { userId: "bob" }))).toBe(false);
    expect(isGroupedWith(undefined, msg(1))).toBe(false);
  });
});

describe("store: users and reactions", async () => {
  const { useChat, selectName } = await import("./index");

  it("applies server reactions to the matching message only", () => {
    const store = useChat.getState();
    store.setSession({ userId: "me", email: "me@mt.ec", role: "member" });
    store.receiveHistory("ch_general", [msg(1), msg(2)], null);
    useChat.getState().setReactions("ch_general", msg(2).sk, { "🎉": ["bob", "me"] });

    const [first, second] = useChat.getState().messagesByChannel.ch_general ?? [];
    expect(first?.reactions).toBeUndefined();
    expect(second?.reactions).toEqual({ "🎉": ["bob", "me"] });
  });

  it("resolves names from the directory, then the email", () => {
    const store = useChat.getState();
    store.setSession({ userId: "me", email: "me@mt.ec", role: "member" });
    store.setUsers([{ userId: "bob", email: "bob@mt.ec", displayName: "Roberto", updatedAt: 1 }]);
    expect(selectName(useChat.getState(), "bob")).toBe("Roberto");
    expect(selectName(useChat.getState(), "me")).toBe("me");
    expect(selectName(useChat.getState(), "ghost", "ghost@mt.ec")).toBe("ghost");

    useChat
      .getState()
      .upsertUser({ userId: "bob", email: "bob@mt.ec", displayName: "Bobby", updatedAt: 2 });
    expect(selectName(useChat.getState(), "bob")).toBe("Bobby");
  });
});

describe("store: threads and the offline cache", async () => {
  const { useChat, parentSkOf } = await import("./index");
  const parent = {
    messageId: "p1",
    channelId: "ch_general",
    sk: "1700000000000#P",
    userId: "a",
    userEmail: "a@x",
    text: "parent",
    attachments: [],
    createdAt: 1_700_000_000_000,
  };
  const reply = (i: number) => ({
    messageId: `r${i}`,
    channelId: "ch_general",
    sk: `thread#1700000000000#P#${1_700_000_000_000 + i}#R${i}`,
    parentId: "p1",
    parentSk: "1700000000000#P",
    userId: "b",
    userEmail: "b@x",
    text: `r${i}`,
    attachments: [],
    createdAt: 1_700_000_000_000 + i,
  });

  it("reads the parent's key out of a reply's", () => {
    expect(parentSkOf(reply(1).sk)).toBe("1700000000000#P");
    expect(parentSkOf("1700000000000#P")).toBeNull();
  });

  it("routes replies to their thread and counters to the parent", () => {
    useChat.setState({
      messagesByChannel: { ch_general: [parent] },
      threads: {},
      threadCursors: {},
    });
    const s = useChat.getState();
    // A reply for a thread that isn't open changes nothing in the channel list.
    s.receiveMessage(reply(1));
    expect(useChat.getState().messagesByChannel.ch_general).toHaveLength(1);
    expect(useChat.getState().threads).toEqual({});
    // Once loaded, replies land in it (deduped), and the parent shows the count.
    s.receiveThreadHistory("1700000000000#P", [reply(1)], null);
    s.receiveMessage(reply(2));
    s.receiveMessage(reply(2));
    expect(useChat.getState().threads["1700000000000#P"]!.map((m) => m.text)).toEqual(["r1", "r2"]);
    s.applyThreadUpdate({
      type: "message.thread_updated",
      channelId: "ch_general",
      sk: parent.sk,
      messageId: "p1",
      replyCount: 2,
      lastReplyAt: 5,
      replyUserIds: ["b"],
    });
    expect(useChat.getState().messagesByChannel.ch_general![0]).toMatchObject({
      replyCount: 2,
      replyUserIds: ["b"],
    });
    // Reactions and edits find a reply by its key.
    s.setReactions("ch_general", reply(2).sk, { "👍": ["a"] });
    s.applyEdit("ch_general", reply(2).sk, "edited", 9);
    const r2 = useChat.getState().threads["1700000000000#P"]![1]!;
    expect(r2).toMatchObject({ reactions: { "👍": ["a"] }, text: "edited", isEdited: true });
  });

  it("hydrates from the cache as stale, and a fresh page clears the mark", () => {
    useChat.getState().setSession({ userId: "me", email: "me@x" } as never);
    useChat.getState().hydrate({
      version: 1,
      savedAt: 1,
      channels: [
        {
          channelId: "ch_general",
          name: "general",
          type: "public",
          createdBy: "s",
          createdAt: 1,
          archived: false,
        },
      ],
      pinned: [],
      users: {},
      directory: { a: "a@x" },
      messagesByChannel: { ch_general: [parent] },
      cursors: { ch_general: "stale" },
      reads: {},
    });
    let s = useChat.getState();
    expect(s.hydrated).toBe(true);
    expect(s.channels).toHaveLength(1);
    expect(s.messagesByChannel.ch_general).toHaveLength(1);
    expect(s.stale.ch_general).toBe(true);
    expect(s.cursors.ch_general).toBe("stale");
    // The server's first page replaces the "stale" cursor with a real one and clears the mark.
    s.historyRequested("ch_general", "initial");
    s.receiveHistory(
      "ch_general",
      [parent, { ...parent, messageId: "p2", sk: "1700000000001#Q" }],
      "cur",
    );
    s = useChat.getState();
    expect(s.stale.ch_general).toBeUndefined();
    expect(s.cursors.ch_general).toBe("cur");
    expect(s.messagesByChannel.ch_general).toHaveLength(2);
    // A reconnect keeps what's cached but marks the inactive channels stale again.
    s.setActiveChannel("dm_x_y");
    s.invalidateInactive();
    expect(useChat.getState().messagesByChannel.ch_general).toHaveLength(2);
    expect(useChat.getState().stale.ch_general).toBe(true);
  });
});
