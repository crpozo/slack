// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyTheme, getAppearance, nativeGlass, setAppearance } from "./theme";

describe("nativeGlass", () => {
  it("is on only when the desktop app reports real OS blur", () => {
    expect(nativeGlass({ __MINDFULTECH_GLASS__: "vibrancy" })).toBe("vibrancy");
    expect(nativeGlass({ __MINDFULTECH_GLASS__: "mica" })).toBe("mica");
  });

  it("is off in browsers, older apps, Windows 10 and Linux", () => {
    expect(nativeGlass({})).toBeNull();
    expect(nativeGlass({ __MINDFULTECH_GLASS__: null })).toBeNull();
    // Anything unexpected: never a transparent page.
    expect(nativeGlass({ __MINDFULTECH_GLASS__: "acrylic" as never })).toBeNull();
  });
});

describe("light and dark (Phase 76)", () => {
  it("is dark unless the person chose light, and remembers the choice", () => {
    localStorage.clear();
    applyTheme();
    expect(getAppearance()).toBe("dark");
    expect([...document.documentElement.classList]).toEqual(["dark"]);
    setAppearance("light");
    expect(localStorage.getItem("slack.appearance")).toBe("light");
    expect([...document.documentElement.classList]).toEqual(["light"]);
    applyTheme();
    expect(document.documentElement.classList.contains("light")).toBe(true);
    setAppearance("dark");
    expect([...document.documentElement.classList]).toEqual(["dark"]);
  });

  it("uses the desktop app's OS glass only in the dark look", () => {
    window.__MINDFULTECH_GLASS__ = "vibrancy";
    setAppearance("dark");
    expect(document.documentElement.classList.contains("native-glass")).toBe(true);
    setAppearance("light");
    expect(document.documentElement.classList.contains("native-glass")).toBe(false);
    delete window.__MINDFULTECH_GLASS__;
    setAppearance("dark");
  });
});
