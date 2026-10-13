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
