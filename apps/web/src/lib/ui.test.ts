import { describe, expect, it } from "vitest";
import { buildGroups, normalizeSearch, QUICK_REACTIONS, searchEmojis } from "./emoji";
import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./sidebar";
describe("sidebar width", () => {
  it("clamps to the allowed range", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(287.6)).toBe(288);
    expect(clampSidebarWidth(Number.NaN)).toBe(256);
  });
});

describe("emoji", () => {
  const raw = [
    { unicode: "😀", label: "grinning face", group: 0, order: 1, tags: ["happy"] },
    { unicode: "👍️", label: "thumbs up", group: 1, order: 353, tags: ["approve"] },
    { unicode: "🏻", label: "light skin tone", group: 2, order: 400 },
    { unicode: "🇪🇨", label: "flag: Ecuador", group: 9, order: 1500, tags: [] },
    { unicode: "x".repeat(17), label: "too long", group: 0, order: 2 },
  ];

  it("groups the dataset, dropping skin-tone components and overlong sequences", () => {
    const groups = buildGroups(raw);
    expect(groups.map((g) => [g.id, g.emojis.map((e) => e.emoji)])).toEqual([
      [0, ["😀"]],
      [1, ["👍️"]],
      [9, ["🇪🇨"]],
    ]);
  });

  it("searches labels and tags, ignoring case and accents", () => {
    const groups = buildGroups(raw);
    expect(searchEmojis(groups, "APPROVE").map((e) => e.emoji)).toEqual(["👍️"]);
    expect(searchEmojis(groups, "flag ecuador").map((e) => e.emoji)).toEqual(["🇪🇨"]);
    expect(searchEmojis(groups, "  ")).toEqual([]);
    expect(normalizeSearch("Crème BRÛLÉE")).toBe("creme brulee");
  });

  it("quick reactions use the dataset's exact strings", () => {
    expect(QUICK_REACTIONS[0]).toBe("👍️");
    expect(QUICK_REACTIONS[1]).toBe("❤️");
  });
});
