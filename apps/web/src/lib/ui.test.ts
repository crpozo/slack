import { describe, expect, it } from "vitest";
import { buildGroups, normalizeSearch, QUICK_REACTIONS, searchEmojis } from "./emoji";
import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./sidebar";
import { isThemePreference, resolveTheme } from "./theme";

describe("theme", () => {
  it("resolves system to the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("validates stored values", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});

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
    { unicode: "😀", label: "cara sonriendo", group: 0, order: 1, tags: ["feliz"] },
    { unicode: "👍️", label: "pulgar hacia arriba", group: 1, order: 353, tags: ["señal"] },
    { unicode: "🏻", label: "tono de piel claro", group: 2, order: 400 },
    { unicode: "🇪🇨", label: "bandera: Ecuador", group: 9, order: 1500, tags: [] },
    { unicode: "x".repeat(17), label: "demasiado largo", group: 0, order: 2 },
  ];

  it("groups the dataset, dropping skin-tone components and overlong sequences", () => {
    const groups = buildGroups(raw);
    expect(groups.map((g) => [g.id, g.emojis.map((e) => e.emoji)])).toEqual([
      [0, ["😀"]],
      [1, ["👍️"]],
      [9, ["🇪🇨"]],
    ]);
  });

  it("searches labels and tags without accents", () => {
    const groups = buildGroups(raw);
    expect(searchEmojis(groups, "Senal").map((e) => e.emoji)).toEqual(["👍️"]);
    expect(searchEmojis(groups, "bandera ecuador").map((e) => e.emoji)).toEqual(["🇪🇨"]);
    expect(searchEmojis(groups, "  ")).toEqual([]);
    expect(normalizeSearch("Corazón ROJO")).toBe("corazon rojo");
  });

  it("quick reactions use the dataset's exact strings", () => {
    expect(QUICK_REACTIONS[0]).toBe("👍️");
    expect(QUICK_REACTIONS[1]).toBe("❤️");
  });
});
