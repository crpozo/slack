import { describe, expect, it } from "vitest";
import {
  canPinMessage,
  extractLinks,
  isIndexable,
  linkDomain,
  linkSnippet,
  MAX_LINKS_PER_MESSAGE,
  PinActionSchema,
  parseAction,
} from "../src";

describe("extractLinks", () => {
  it("finds the links a message shows, without trailing punctuation or duplicates", () => {
    expect(
      extractLinks(
        "Docs: https://docs.mindfultech.ec/setup. Also (https://x.ec/a?b=1) and https://docs.mindfultech.ec/setup!",
      ),
    ).toEqual(["https://docs.mindfultech.ec/setup", "https://x.ec/a?b=1"]);
  });

  it("ignores links inside code, like the message itself does", () => {
    expect(extractLinks("run `curl https://api.local/x` or see https://real.ec")).toEqual([
      "https://real.ec",
    ]);
    expect(extractLinks("```\nhttps://in-a-block.ec\n```\nhttps://after.ec")).toEqual([
      "https://after.ec",
    ]);
  });

  it("only http(s), and at most MAX_LINKS_PER_MESSAGE", () => {
    expect(extractLinks("ftp://x.ec mailto:a@b.ec javascript:alert(1)")).toEqual([]);
    const many = Array.from({ length: 15 }, (_, i) => `https://s${i}.ec`).join(" ");
    expect(extractLinks(many)).toHaveLength(MAX_LINKS_PER_MESSAGE);
  });
});

describe("link rows", () => {
  it("shows the domain without www, and a short snippet", () => {
    expect(linkDomain("https://www.youtube.com/watch?v=1")).toBe("youtube.com");
    expect(linkDomain("not a url")).toBe("not a url");
    expect(linkSnippet("  a\n\nb  ")).toBe("a b");
    expect(linkSnippet("x".repeat(200))).toHaveLength(140);
  });
});

describe("what gets indexed and pinned", () => {
  it("indexes ordinary messages only", () => {
    expect(isIndexable({})).toBe(true);
    expect(isIndexable({ isSecret: true })).toBe(false);
    expect(isIndexable({ kind: "meeting" })).toBe(false);
    expect(isIndexable({ deletedAt: 1 })).toBe(false);
  });

  it("pins anything but secrets and deleted messages", () => {
    expect(canPinMessage({})).toBe(true);
    expect(canPinMessage({ isSecret: true })).toBe(false);
    expect(canPinMessage({ deletedAt: 1 })).toBe(false);
  });

  it("parses the pin action", () => {
    const body = JSON.stringify({
      action: "pin",
      channelId: "ch_general",
      sk: "1#A",
      pinned: true,
    });
    expect(parseAction(PinActionSchema, body).success).toBe(true);
    expect(
      parseAction(
        PinActionSchema,
        JSON.stringify({ action: "pin", channelId: "ch_general", sk: "1#A" }),
      ).success,
    ).toBe(false);
  });
});
