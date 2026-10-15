import { describe, expect, it } from "vitest";
import {
  countUnread,
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

describe("countUnread", () => {
  it("counts other people's confirmed messages after lastRead", () => {
    const messages = [
      msg(1, { userId: "bob" }),
      msg(2, { userId: "bob" }),
      msg(3, { userId: "me" }),
      msg(4, { userId: "bob", status: "pending" }),
    ];
    expect(countUnread(messages, 1_700_000_000_001, "me")).toBe(1);
    expect(countUnread(messages, 0, "me")).toBe(2);
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
