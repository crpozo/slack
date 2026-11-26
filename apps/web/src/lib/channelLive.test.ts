// @vitest-environment jsdom
import type { Channel } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../store";

/** A WebSocket client that records what is sent and lets the test play server events. */
const fake = vi.hoisted(() => {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sent: Array<{ action: string; payload: Record<string, unknown> }> = [];
  return {
    handlers,
    sent,
    emit(type: string, event: Record<string, unknown>) {
      for (const h of handlers.get(type) ?? []) h({ type, ...event });
    },
  };
});

vi.mock("./ws", () => ({
  WsClient: class {
    status = "open";
    on(type: string, handler: (event: unknown) => void) {
      const set = fake.handlers.get(type) ?? new Set();
      set.add(handler);
      fake.handlers.set(type, set);
      return () => set.delete(handler);
    }
    onStatus() {
      return () => {};
    }
    onOpen() {
      return () => {};
    }
    send(action: string, payload: Record<string, unknown>) {
      fake.sent.push({ action, payload });
    }
    ping() {}
    connect() {}
    disconnect() {}
  },
}));

const { chat } = await import("./chat");

const ME = { userId: "u-me", email: "me@mt.ec", role: "member" as const };
const row = (channelId: string, name: string, extra: Partial<Channel> = {}): Channel => ({
  channelId,
  name,
  type: "private",
  createdBy: "u-ana",
  createdAt: 1,
  archived: false,
  members: ["u-ana", ME.userId],
  ...extra,
});
const sentOp = (op: string) => fake.sent.filter((s) => s.payload.op === op);
const channelIds = () => useChat.getState().channels.map((c) => c.channelId);
const statusOf = (id: string) =>
  useChat.getState().channels.find((c) => c.channelId === id)?.projectStatus;

beforeEach(() => {
  fake.handlers.clear();
  fake.sent.length = 0;
  useChat.getState().setSession(ME, []);
  useChat.setState({ toast: null, channels: [row("ch_team", "Team")] });
  chat.start("wss://test", () => {});
});

afterEach(() => {
  chat.stop();
  vi.useRealTimers();
});

describe("creating a channel", () => {
  it("resolves on the server's channel.created for its request, and invites then", async () => {
    const creating = chat.createChannel("NaturalVitality", "private", ["u-ana"]);
    const { requestId } = sentOp("create")[0]!.payload;
    expect(requestId).toEqual(expect.any(String));
    // Someone else's new channel arriving meanwhile isn't the answer.
    fake.emit("channel.created", { channel: row("ch_other", "Other") });
    fake.emit("channel.created", { channel: row("ch_nv", "NaturalVitality"), requestId });
    await expect(creating).resolves.toBe("ch_nv");
    expect(channelIds()).toEqual(["ch_team", "ch_other", "ch_nv"]);
    expect(sentOp("invite")[0]?.payload).toMatchObject({ channelId: "ch_nv", userIds: ["u-ana"] });
  });

  it("fails with the server's own error, at once (not a timeout)", async () => {
    const creating = chat.createChannel("NaturalVitality");
    const { requestId } = sentOp("create")[0]!.payload;
    fake.emit("error", { code: "INTERNAL_ERROR", requestId });
    await expect(creating).rejects.toThrow();
    await expect(creating).rejects.not.toThrow(/didn't respond/);
    // And the next attempt isn't blocked by the failed one.
    const again = chat.createChannel("NaturalVitality");
    fake.emit("channel.created", {
      channel: row("ch_nv", "NaturalVitality"),
      requestId: sentOp("create")[1]!.payload.requestId,
    });
    await expect(again).resolves.toBe("ch_nv");
  });

  it("still resolves on the list from a server that doesn't send channel.created", async () => {
    const creating = chat.createChannel("NaturalVitality");
    fake.emit("channel.list", { channels: [row("ch_nv", "NaturalVitality")] });
    await expect(creating).resolves.toBe("ch_nv");
  });
});

describe("channels live, without a reload", () => {
  it("adds a channel someone else created, once", () => {
    fake.emit("channel.created", { channel: row("ch_new", "New") });
    fake.emit("channel.created", { channel: row("ch_new", "New") });
    expect(channelIds()).toEqual(["ch_team", "ch_new"]);
  });

  it("shows someone else's status change", () => {
    fake.emit("channel.updated", { channel: row("ch_team", "Team", { projectStatus: "standby" }) });
    expect(statusOf("ch_team")).toBe("standby");
  });

  it("shows your own change at once, and goes back to the server's when it's refused", () => {
    chat.setProjectStatus("ch_team", "completed");
    expect(statusOf("ch_team")).toBe("completed");
    expect(sentOp("update")[0]?.payload).toEqual({
      op: "update",
      channelId: "ch_team",
      projectStatus: "completed",
    });
    fake.emit("error", { code: "FORBIDDEN" });
    expect(sentOp("list")).toHaveLength(1);
    fake.emit("channel.list", { channels: [row("ch_team", "Team")] });
    expect(statusOf("ch_team")).toBeUndefined();
    // Confirmed changes aren't re-read on a later, unrelated error.
    chat.setProjectStatus("ch_team", "standby");
    fake.emit("channel.updated", { channel: row("ch_team", "Team", { projectStatus: "standby" }) });
    fake.emit("error", { code: "BAD_REQUEST" });
    expect(sentOp("list")).toHaveLength(1);
  });
});
