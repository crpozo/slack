// @vitest-environment jsdom
import { dmChannelId } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../store";
import { dmEntries } from "./channels";

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

const { chat, DM_UNAVAILABLE_TEXT } = await import("./chat");

const ME = { userId: "u-me", email: "me@mt.ec", role: "member" as const };
const GONE = "u-gone";
const DM = dmChannelId(ME.userId, GONE);
const lastDmRequest = () => fake.sent.filter((s) => s.payload.op === "dm").at(-1)!.payload;
/** How many times the directory (`user` `list`) has been asked for. */
const userLists = () =>
  fake.sent.filter((m) => m.action === "user" && m.payload.op === "list").length;

beforeEach(() => {
  fake.handlers.clear();
  fake.sent.length = 0;
  useChat.getState().setSession(ME, []);
  useChat.setState({ toast: null });
  chat.start("wss://test", () => {});
});

afterEach(() => {
  chat.stop();
  vi.useRealTimers();
});

describe("opening a DM with someone whose account is gone", () => {
  it("toasts, clears the spinner, tells the layout to leave and re-reads the directory", async () => {
    const failed = vi.fn();
    const off = chat.onDmFailed(failed);
    useChat.setState({ historyRequests: { [DM]: "initial" } });

    expect(chat.openDm(GONE)).toBe(DM);
    const { requestId } = lastDmRequest();
    expect(requestId).toEqual(expect.any(String));
    const listsBefore = userLists();
    fake.emit("error", { code: "USER_NOT_FOUND", requestId });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(DM, GONE));
    off();

    const s = useChat.getState();
    expect(s.toast).toMatchObject({ message: DM_UNAVAILABLE_TEXT, tone: "info" });
    expect(s.historyRequests[DM]).toBeUndefined();
    // No local "hide this one": a fresh directory from the server, which no longer lists them.
    expect(userLists()).toBe(listsBefore + 1);
    fake.emit("user.list", {
      users: [{ userId: "u-ana", email: "ana@mt.ec", displayName: "Ana", updatedAt: 0 }],
    });
    const after = useChat.getState();
    const dmWithGone = {
      channelId: DM,
      name: DM,
      type: "dm" as const,
      createdBy: ME.userId,
      createdAt: 1,
      archived: false,
    };
    const listed = dmEntries(
      [{ userId: GONE, email: "gone@mt.ec" }],
      [dmWithGone],
      ME,
      after.directory,
      (id) => dmChannelId(ME.userId, id),
      after.users,
      after.usersLoaded,
    );
    expect(listed.map((e) => e.userId)).toEqual(["u-ana"]);
  });

  it("settles quietly when the server confirms the DM, and shares one request per DM", async () => {
    const failed = vi.fn();
    const off = chat.onDmFailed(failed);
    chat.openDm("u-ana");
    chat.openDm("u-ana");
    const requests = fake.sent.filter((s) => s.payload.op === "dm");
    expect(requests).toHaveLength(1);
    fake.emit("channel.dm_opened", {
      channelId: dmChannelId(ME.userId, "u-ana"),
      requestId: requests[0]!.payload.requestId,
    });
    await Promise.resolve();
    off();
    expect(failed).not.toHaveBeenCalled();
    expect(useChat.getState().toast).toBeNull();
  });

  it("gives up after the request timeout instead of hanging", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const off = chat.onDmFailed(failed);
    const listsBefore = userLists();
    chat.openDm(GONE);
    await vi.advanceTimersByTimeAsync(15_000);
    off();
    expect(failed).toHaveBeenCalledWith(DM, GONE);
    expect(useChat.getState().toast).toMatchObject({ tone: "error" });
    // A timeout isn't proof the account is gone: no directory re-read for it.
    expect(userLists()).toBe(listsBefore);
  });
});

describe("history of a DM that doesn't exist yet", () => {
  it("is never asked for (the server would answer CHANNEL_NOT_FOUND and the list would hang)", () => {
    chat.loadHistory(DM, "initial");
    expect(fake.sent.filter((s) => s.action === "history")).toHaveLength(0);
    expect(useChat.getState().historyRequests[DM]).toBeUndefined();

    useChat.getState().setChannels([
      {
        channelId: DM,
        name: DM,
        type: "dm",
        createdBy: ME.userId,
        createdAt: 1,
        archived: false,
        members: [ME.userId, GONE],
      },
    ]);
    chat.loadHistory(DM, "initial");
    expect(fake.sent.filter((s) => s.action === "history")).toHaveLength(1);
  });
});
