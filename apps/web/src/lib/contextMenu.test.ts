import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../store";
import { menuActions, placeMenu } from "./contextMenu";

const message = (patch: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    messageId: "m1",
    channelId: "ch_general",
    sk: "1#m1",
    userId: "me",
    userEmail: "me@x",
    text: "hello https://x.y",
    attachments: [],
    createdAt: 1,
    ...patch,
  }) as ChatMessage;
const ctx = { mine: true, canThread: true, selection: "", link: null };

describe("message context menu", () => {
  it("leads with copying, then the toolbar's actions", () => {
    expect(menuActions(message(), ctx)).toEqual(["copy", "reply", "thread", "edit"]);
    expect(menuActions(message(), { ...ctx, mine: false })).toEqual(["copy", "reply", "thread"]);
    expect(menuActions(message(), { ...ctx, canThread: false, mine: false })).toEqual([
      "copy",
      "reply",
    ]);
  });

  it("offers the selection and the right-clicked link", () => {
    expect(menuActions(message(), { ...ctx, selection: "hel", link: "https://x.y/" })).toEqual([
      "copy-selection",
      "copy",
      "open-link",
      "copy-link",
      "reply",
      "thread",
      "edit",
    ]);
    expect(menuActions(message(), { ...ctx, selection: "   " })[0]).toBe("copy");
  });

  it("never copies a secret, and edits only plain messages of your own", () => {
    expect(menuActions(message({ isSecret: true }), ctx)).toEqual(["reply"]);
    expect(menuActions(message({ kind: "meeting" }), ctx)).toEqual(["copy", "reply", "thread"]);
    expect(menuActions(message({ text: "" }), ctx)).toEqual(["reply", "thread"]);
  });

  it("an unsent message can only be copied", () => {
    expect(menuActions(message({ status: "failed" }), ctx)).toEqual(["copy"]);
  });

  it("opens at the pointer, flipping and clamping to stay on screen", () => {
    const viewport = { width: 1000, height: 800 };
    expect(placeMenu(100, 100, 200, 300, viewport)).toEqual({ left: 100, top: 100 });
    expect(placeMenu(900, 100, 200, 300, viewport)).toEqual({ left: 700, top: 100 });
    expect(placeMenu(100, 700, 200, 300, viewport)).toEqual({ left: 100, top: 400 });
    // No room either way: pinned inside the margins.
    expect(placeMenu(150, 200, 200, 300, { width: 300, height: 400 })).toEqual({
      left: 8,
      top: 8,
    });
  });
});
