import { describe, expect, it } from "vitest";
import { nativeGlass } from "./theme";

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
