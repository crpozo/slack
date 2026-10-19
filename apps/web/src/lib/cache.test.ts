import type { Message } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import {
  cacheableMessages,
  CACHED_MESSAGES_PER_CHANNEL,
  createPersister,
  snapshotOf,
} from "./cache";

const msg = (i: number, patch: Partial<Message & { status?: string }> = {}): Message =>
  ({
    messageId: `m${i}`,
    channelId: "ch_general",
    sk: `${1_700_000_000_000 + i}#m${i}`,
    userId: "u",
    userEmail: "u@x",
    text: `m${i}`,
    attachments: [],
    createdAt: 1_700_000_000_000 + i,
    readBy: ["a"],
    ...patch,
  }) as Message;

describe("cache snapshot", () => {
  it("keeps the newest page of confirmed, non-secret messages without derived fields", () => {
    const list = [
      ...Array.from({ length: 60 }, (_, i) => msg(i)),
      msg(99, { isSecret: true }),
      msg(100, { status: "pending" } as never),
    ];
    const kept = cacheableMessages(list);
    expect(kept).toHaveLength(CACHED_MESSAGES_PER_CHANNEL);
    expect(kept[0]!.messageId).toBe("m10");
    expect(kept.at(-1)!.messageId).toBe("m59");
    expect(kept.some((m) => m.isSecret)).toBe(false);
    expect("readBy" in kept[0]!).toBe(false);
  });

  it("marks trimmed channels as having older pages, keeps whole ones as complete", () => {
    const snapshot = snapshotOf({
      channels: [],
      pinned: [],
      users: {},
      directory: {},
      messagesByChannel: {
        big: Array.from({ length: 70 }, (_, i) => msg(i)),
        small: [msg(1), msg(2)],
        empty: [],
      },
      cursors: { big: null, small: null },
      reads: {},
    });
    expect(Object.keys(snapshot.messagesByChannel).sort()).toEqual(["big", "small"]);
    expect(snapshot.cursors.big).toBe("stale"); // there is more than we kept
    expect(snapshot.cursors.small).toBeNull(); // everything is cached
  });

  it("coalesces saves", () => {
    vi.useFakeTimers();
    const read = vi.fn(() => ({ version: 1 }) as never);
    const persister = createPersister("u", read);
    persister.schedule();
    persister.schedule();
    persister.schedule();
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(1);
    persister.schedule();
    persister.stop();
    vi.advanceTimersByTime(2000);
    expect(read).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
