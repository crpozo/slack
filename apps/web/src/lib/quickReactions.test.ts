// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { countEmoji, QUICK_REACTIONS, quickReactions } from "./emoji";

describe("the quick reactions next to a message", () => {
  beforeEach(() => {
    localStorage.clear();
    countEmoji("🔥");
    localStorage.clear();
  });

  it("are the usual six until the person has favourites", () => {
    countEmoji("x"); // drops what was remembered
    localStorage.clear();
    countEmoji("🙏");
    expect(quickReactions()).toHaveLength(QUICK_REACTIONS.length);
    expect(quickReactions()[0]).toBe("🙏");
  });

  it("put the most used first and never the same emoji twice", () => {
    for (let i = 0; i < 3; i++) countEmoji("🚀");
    for (let i = 0; i < 2; i++) countEmoji("👍");
    countEmoji("🔥");
    const row = quickReactions();
    expect(row.slice(0, 3)).toEqual(["🚀", "👍", "🔥"]);
    expect(row).toHaveLength(6);
    // 👍 from the picker and the default 👍️ (with its variation selector) are one.
    expect(row.filter((e) => e.replace(/️/g, "") === "👍")).toHaveLength(1);
    expect(row).toContain("❤️");
  });
});
