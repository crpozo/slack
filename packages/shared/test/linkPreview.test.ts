import { describe, expect, it } from "vitest";
import { isPreviewableUrl, previewLinkOf } from "../src/linkPreview";

describe("which link gets a preview card (Phase 64)", () => {
  it("only http(s) links, without credentials, not too long", () => {
    expect(isPreviewableUrl("https://acme.example/post")).toBe(true);
    expect(isPreviewableUrl("http://acme.example")).toBe(true);
    expect(isPreviewableUrl("javascript:alert(1)")).toBe(false);
    expect(isPreviewableUrl("https://user:pw@acme.example/")).toBe(false);
    expect(isPreviewableUrl(`https://acme.example/${"x".repeat(3000)}`)).toBe(false);
  });

  it("the first link the message shows, skipping those with their own preview", () => {
    const text = "see https://youtu.be/abc and https://acme.example/post, then https://b.example";
    expect(previewLinkOf(text)).toBe("https://youtu.be/abc");
    expect(previewLinkOf(text, (u) => u.includes("youtu"))).toBe("https://acme.example/post");
    expect(previewLinkOf("`https://in-code.example` nothing else")).toBeNull();
    expect(previewLinkOf("no links")).toBeNull();
  });
});
