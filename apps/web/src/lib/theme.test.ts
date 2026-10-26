import { describe, expect, it } from "vitest";
import { resolveLook, resolveTheme } from "./theme";

describe("resolveLook", () => {
  it("follows the preference on desktop", () => {
    expect(resolveLook("light", true, false)).toBe("light");
    expect(resolveLook("dark", false, false)).toBe("dark");
    expect(resolveLook("system", true, false)).toBe(resolveTheme("system", true));
  });

  it("is always the phone look on phones, whatever the preference", () => {
    for (const pref of ["light", "dark", "system"] as const) {
      expect(resolveLook(pref, false, true)).toBe("phone");
    }
  });
});
