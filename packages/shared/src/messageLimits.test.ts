import { describe, expect, it } from "vitest";
import {
  EditActionSchema,
  MAX_TEXT_BYTES,
  MAX_TEXT_LENGTH,
  MessageActionSchema,
  textTooLong,
} from "./protocol";

const message = (text: string) => ({
  action: "message",
  channelId: "ch_general",
  text,
  clientId: "c1",
});

describe("message length (Phase 55)", () => {
  it("takes a long brief (up to 10,000 characters)", () => {
    const brief = "Inventario de formularios: tabla con nombre y página.\n".repeat(90); // ~4,900
    expect(textTooLong(brief)).toBe(false);
    expect(MessageActionSchema.safeParse(message(brief)).success).toBe(true);
    expect(MessageActionSchema.safeParse(message("a".repeat(MAX_TEXT_LENGTH))).success).toBe(true);
  });

  it("refuses more than 10,000 characters, or more bytes than a WebSocket frame takes", () => {
    expect(textTooLong("a".repeat(MAX_TEXT_LENGTH + 1))).toBe(true);
    expect(MessageActionSchema.safeParse(message("a".repeat(MAX_TEXT_LENGTH + 1))).success).toBe(
      false,
    );
    // Emoji: 4 bytes each, so 6,001 of them are under 10,000 characters but over the bytes.
    const emoji = "😀".repeat(MAX_TEXT_BYTES / 4 + 1);
    expect(textTooLong(emoji)).toBe(true);
    expect(MessageActionSchema.safeParse(message(emoji)).success).toBe(false);
    expect(
      EditActionSchema.safeParse({
        action: "edit",
        channelId: "ch_general",
        sk: "1#a",
        text: "a".repeat(MAX_TEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
