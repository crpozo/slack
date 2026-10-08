import { describe, expect, it } from "vitest";
import {
  ClientActionSchema,
  MAX_ATTACHMENT_SIZE,
  MAX_TEXT_LENGTH,
  MessageActionSchema,
  parseAction,
} from "../src";

describe("protocol", () => {
  it("accepts every client action", () => {
    const actions = [
      { action: "message", channelId: "ch_general", text: "hola", clientId: "x" },
      { action: "history", channelId: "ch_general", cursor: "abc" },
      { action: "channel", op: "list" },
      { action: "channel", op: "create", name: "dev-team" },
      { action: "channel", op: "dm", withUserId: "user-1" },
      {
        action: "presign",
        op: "put",
        requestId: "r1",
        channelId: "ch_general",
        name: "foto.png",
        contentType: "image/png",
        size: 1024,
      },
      { action: "presign", op: "get", requestId: "r2", key: "attachments/ch_general/x-foto.png" },
      { action: "typing", channelId: "ch_general" },
    ];
    for (const action of actions) {
      expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
    }
  });

  it("enforces text, size and channel-name limits", () => {
    const tooLong = {
      action: "message",
      channelId: "c",
      text: "a".repeat(MAX_TEXT_LENGTH + 1),
      clientId: "x",
    };
    const tooBig = {
      action: "presign",
      op: "put",
      requestId: "r",
      channelId: "c",
      name: "big.bin",
      contentType: "application/octet-stream",
      size: MAX_ATTACHMENT_SIZE + 1,
    };
    const badName = { action: "channel", op: "create", name: "Dev Team" };
    for (const action of [tooLong, tooBig, badName]) {
      expect(ClientActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(false);
    }
  });

  it("parseAction rejects invalid JSON and schema mismatches", () => {
    expect(parseAction(MessageActionSchema, "{nope").success).toBe(false);
    expect(parseAction(MessageActionSchema, undefined).success).toBe(false);
    expect(parseAction(MessageActionSchema, JSON.stringify({ action: "message" })).success).toBe(
      false,
    );

    const ok = parseAction(
      MessageActionSchema,
      JSON.stringify({ action: "message", channelId: "c", text: "hola", clientId: "x" }),
    );
    expect(ok).toEqual({
      success: true,
      data: { action: "message", channelId: "c", text: "hola", clientId: "x" },
    });
  });
});
