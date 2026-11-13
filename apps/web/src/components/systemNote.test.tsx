// @vitest-environment jsdom
import type { Message } from "@mindfultech/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChat } from "../store";
import { isGroupedWith } from "../store/messages";
import { SystemNote } from "./SystemNote";

const note: Message = {
  messageId: "m1",
  channelId: "ch_team",
  sk: "1#m1",
  userId: "u-ana",
  userEmail: "ana@mt.ec",
  text: "@luis was removed from the channel by ana",
  attachments: [],
  createdAt: 1_700_000_000_000,
  kind: "system",
  system: { event: "member_removed", userIds: ["u-luis"], by: "u-ana" },
};

beforeEach(() => {
  useChat.getState().setSession({ userId: "u-me", email: "me@mt.ec", role: "member" }, []);
  useChat.getState().setUsers([
    { userId: "u-ana", email: "ana@mt.ec", displayName: "Ana", updatedAt: 1 },
    { userId: "u-luis", email: "luis@mt.ec", displayName: "Luis Pérez", updatedAt: 1 },
  ]);
});
afterEach(cleanup);

describe("system notes in the feed (Phase 63)", () => {
  it("read as a small centered line, with today's names", () => {
    render(<SystemNote message={note} />);
    const line = screen.getByRole("note");
    expect(line.textContent).toMatch(/^@Luis Pérez was removed from the channel by Ana/);
    expect(line.className).toMatch(/justify-center/);
    expect(line.querySelector("p")?.className).toMatch(/text-xs/);
    expect(line.querySelector("p")?.className).toMatch(/text-ink-secondary/);
  });

  it("never group with the messages around them", () => {
    const text = {
      ...note,
      kind: undefined,
      system: undefined,
      messageId: "m2",
      createdAt: note.createdAt + 1000,
    };
    expect(isGroupedWith(note, text)).toBe(false);
    expect(isGroupedWith(text, { ...note, createdAt: note.createdAt + 2000 })).toBe(false);
    expect(
      isGroupedWith(text, { ...text, messageId: "m3", createdAt: text.createdAt + 1000 }),
    ).toBe(true);
  });
});
