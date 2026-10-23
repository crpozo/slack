import type { Message } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useChat, type ChatMessage } from ".";

const CH = "ch_general";
const msg = (sk: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m-${sk}`,
  channelId: CH,
  sk,
  userId: "u-ana",
  userEmail: "ana@x.ec",
  text: `text ${sk}`,
  attachments: [],
  createdAt: Number(sk.split("#")[0]),
  ...patch,
});
const sks = () => (useChat.getState().messagesByChannel[CH] ?? []).map((m) => m.sk);

beforeEach(() => {
  useChat.setState({
    me: { userId: "u-me", email: "me@x.ec", role: "member" },
    messagesByChannel: { [CH]: [msg("100#a"), msg("200#b"), msg("300#c")] },
    threads: {},
    unread: { [CH]: 2 },
    reads: { [CH]: { "u-me": { sk: "100#a", at: 1 } } },
    replyTo: {},
    editing: {},
    historyRequests: {},
    cursors: {},
  });
});

describe("deleting messages in the store (Phase 32)", () => {
  it("removes a message, with its unread count, a pending reply to it and an edit of it", () => {
    useChat.setState({
      replyTo: {
        [CH]: {
          messageId: "m-200#b",
          sk: "200#b",
          userId: "u-ana",
          preview: "x",
          hasAttachments: false,
        },
      },
      editing: { [CH]: { sk: "200#b", messageId: "m-200#b", text: "x" } },
    });
    useChat.getState().removeMessage(CH, "200#b");
    const s = useChat.getState();
    expect(sks()).toEqual(["100#a", "300#c"]);
    expect(s.unread[CH]).toBe(1); // it was after your read mark
    expect(s.replyTo[CH]).toBeUndefined();
    expect(s.editing[CH]).toBeUndefined();

    useChat.getState().removeMessage(CH, "100#a"); // already read: the count stays
    expect(useChat.getState().unread[CH]).toBe(1);
    useChat.getState().removeMessage(CH, "999#gone"); // unknown: nothing changes
    expect(sks()).toEqual(["300#c"]);
  });

  it("removes a thread reply from its thread, and a parent's loaded thread with it", () => {
    const reply = msg("thread#300#c#400#r", { parentSk: "300#c" });
    useChat.setState({ threads: { "300#c": [reply] } });
    useChat.getState().removeMessage(CH, reply.sk);
    expect(useChat.getState().threads["300#c"]).toEqual([]);
    useChat.getState().removeMessage(CH, "300#c");
    expect("300#c" in useChat.getState().threads).toBe(false);
  });

  it("puts a message back when the server refuses the delete", () => {
    const b = useChat.getState().messagesByChannel[CH]![1]!;
    useChat.getState().removeMessage(CH, b.sk);
    useChat.getState().restoreMessage(b);
    expect(sks()).toEqual(["100#a", "200#b", "300#c"]);
  });

  it("turns a parent with replies into a tombstone: no text, files, reactions or card", () => {
    useChat.setState({
      messagesByChannel: {
        [CH]: [
          msg("100#a", {
            replyCount: 2,
            reactions: { "👍": ["u-me"] },
            attachments: [{ key: "k", name: "a.png", size: 1, contentType: "image/png" }],
            isEdited: true,
          }),
        ],
      },
    });
    useChat.getState().applyTombstone(CH, "100#a", 5);
    expect(useChat.getState().messagesByChannel[CH]![0]).toEqual({
      ...msg("100#a"),
      text: "",
      attachments: [],
      reactions: {},
      replyCount: 2,
      deletedAt: 5,
    });
  });

  it("marks a quote whose original was deleted, without counting it as an edit", () => {
    const quote = {
      messageId: "m-100#a",
      sk: "100#a",
      userId: "u-ana",
      preview: "",
      hasAttachments: false,
      deleted: true as const,
    };
    useChat.getState().applyQuote(CH, "300#c", quote);
    const c = useChat.getState().messagesByChannel[CH]![2]!;
    expect(c.replyTo).toEqual(quote);
    expect(c.isEdited).toBeUndefined();
  });

  it("a refreshed newest page drops cached messages deleted meanwhile, keeping older and newer ones", () => {
    useChat.setState({
      messagesByChannel: {
        [CH]: [
          msg("050#old"), // older than the page: unknown, kept
          msg("100#a"),
          msg("200#b"), // deleted while we were away
          msg("300#c"),
          msg("400#new"), // arrived over the socket after the page was read: kept
          msg("pending", { status: "pending", sk: "250#p" }),
        ],
      },
      historyRequests: { [CH]: "initial" },
    });
    const page: Message[] = [msg("100#a"), msg("300#c")];
    useChat.getState().receiveHistory(CH, page, "cursor");
    expect(sks()).toContain("250#p"); // still being sent: kept (it sorts by its own rule)
    expect(sks().filter((sk) => sk !== "250#p")).toEqual(["050#old", "100#a", "300#c", "400#new"]);
  });

  it("an older page never drops anything", () => {
    useChat.setState({ historyRequests: { [CH]: "older" } });
    useChat.getState().receiveHistory(CH, [msg("100#a")], null);
    expect(sks()).toEqual(["100#a", "200#b", "300#c"]);
  });
});
