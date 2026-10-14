import type { Channel, UserProfile } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useChat } from ".";

const alice: UserProfile = { userId: "u-a", email: "a@mt.ec", displayName: "Alice", updatedAt: 1 };
const bob: UserProfile = { userId: "u-b", email: "b@mt.ec", displayName: "Bob", updatedAt: 1 };
const channel = (channelId: string): Channel => ({
  channelId,
  name: channelId,
  type: "public",
  createdBy: "u-a",
  createdAt: 1,
  archived: false,
});

describe("presence", () => {
  beforeEach(() => useChat.setState({ users: {}, online: {}, directory: {} }));

  it("takes the snapshot from user.list and keeps it when a list has none", () => {
    useChat.getState().setUsers([alice, bob], ["u-a"]);
    expect(useChat.getState().online).toEqual({ "u-a": true });

    useChat.getState().setUsers([alice, bob]);
    expect(useChat.getState().online).toEqual({ "u-a": true });
  });

  it("applies user.connected / user.disconnected", () => {
    const { setPresence } = useChat.getState();
    setPresence("u-b", true);
    setPresence("u-a", true);
    setPresence("u-a", false);
    expect(useChat.getState().online).toEqual({ "u-b": true });
  });

  it("doesn't touch state for a no-op change", () => {
    useChat.getState().setPresence("u-a", true);
    const before = useChat.getState().online;
    useChat.getState().setPresence("u-a", true);
    expect(useChat.getState().online).toBe(before);
  });
});

describe("removeChannel", () => {
  it("drops the channel and everything cached for it", () => {
    useChat.setState({
      channels: [channel("ch_a"), channel("ch_b")],
      messagesByChannel: { ch_a: [], ch_b: [] },
      cursors: { ch_a: "x", ch_b: null },
      historyRequests: { ch_a: "older" },
    });

    useChat.getState().removeChannel("ch_a");

    const s = useChat.getState();
    expect(s.channels.map((c) => c.channelId)).toEqual(["ch_b"]);
    expect(s.messagesByChannel).toEqual({ ch_b: [] });
    expect(s.cursors).toEqual({ ch_b: null });
    expect(s.historyRequests).toEqual({});
  });
});

describe("replyTo", () => {
  const reply = {
    messageId: "m1",
    sk: "1#m1",
    userId: "u-b",
    preview: "hi",
    hasAttachments: false,
  };

  it("is kept per channel and cleared on cancel, send, or channel removal", () => {
    const { setReplyTo } = useChat.getState();
    setReplyTo("ch_a", reply);
    setReplyTo("ch_b", { ...reply, messageId: "m2" });
    expect(useChat.getState().replyTo.ch_a).toEqual(reply);

    setReplyTo("ch_a", null);
    expect(useChat.getState().replyTo.ch_a).toBeUndefined();
    expect(useChat.getState().replyTo.ch_b?.messageId).toBe("m2");

    useChat.setState({ channels: [channel("ch_b")] });
    useChat.getState().removeChannel("ch_b");
    expect(useChat.getState().replyTo).toEqual({});
  });
});

describe("read marks, typing and edits", () => {
  const m = (sk: string, userId: string) => ({
    messageId: sk,
    channelId: "dm_a_b",
    sk,
    userId,
    userEmail: `${userId}@mt.ec`,
    text: "hi",
    attachments: [],
    createdAt: 1,
  });
  beforeEach(() =>
    useChat.setState({
      reads: {},
      typing: {},
      editing: {},
      messagesByChannel: { dm_a_b: [m("1#a", "u-a"), m("2#b", "u-b")] },
    }),
  );

  it("seeds watermarks from channel.list and only ever moves them forward", () => {
    const { setChannels, setReadMark } = useChat.getState();
    setChannels([{ ...channel("dm_a_b"), reads: { "u-b": { sk: "1#a", at: 1 } } }]);
    expect(useChat.getState().reads).toEqual({ dm_a_b: { "u-b": { sk: "1#a", at: 1 } } });

    setReadMark("dm_a_b", "u-b", { sk: "2#b", at: 2 });
    setReadMark("dm_a_b", "u-b", { sk: "1#a", at: 3 }); // stale echo: ignored
    expect(useChat.getState().reads.dm_a_b).toEqual({ "u-b": { sk: "2#b", at: 2 } });
  });

  it("keeps typing indicators per channel with their expiry", () => {
    const { setTyping } = useChat.getState();
    setTyping("dm_a_b", "u-b", 1000);
    setTyping("dm_a_b", "u-c", 2000);
    setTyping("dm_a_b", "u-b", null);
    expect(useChat.getState().typing).toEqual({ dm_a_b: { "u-c": 2000 } });
  });

  it("applies message.updated to the cached message and tracks the composer's edit", () => {
    const { applyEdit, setEditing } = useChat.getState();
    applyEdit("dm_a_b", "1#a", "hello", 5);
    applyEdit("dm_a_b", "9#z", "nope", 5); // not loaded: no-op
    expect(useChat.getState().messagesByChannel.dm_a_b?.[0]).toMatchObject({
      text: "hello",
      isEdited: true,
      editedAt: 5,
    });
    setEditing("dm_a_b", { sk: "1#a", messageId: "1#a", text: "hello" });
    expect(useChat.getState().editing.dm_a_b?.sk).toBe("1#a");
    setEditing("dm_a_b", null);
    expect(useChat.getState().editing.dm_a_b).toBeUndefined();
  });
});
