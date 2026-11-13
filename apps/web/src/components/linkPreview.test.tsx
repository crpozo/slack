// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewLinkIn, resetLinkPreviews } from "../lib/linkPreview";
import * as api from "../lib/tasksApi";
import { ComposerLinkPreview, LinkPreviewCard } from "./LinkPreviewCard";

// Phase 63: a shared link shows its page's preview under the message.

beforeEach(() => resetLinkPreviews());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("which link a message previews", () => {
  it("its first https link outside code, and not a YouTube video", () => {
    expect(previewLinkIn("mira https://example.com/a y https://example.com/b")).toBe(
      "https://example.com/a",
    );
    expect(previewLinkIn("`https://example.com/code` luego https://example.com/real")).toBe(
      "https://example.com/real",
    );
    expect(previewLinkIn("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(previewLinkIn("http://example.com/plain")).toBeNull();
    expect(previewLinkIn("sin enlaces")).toBeNull();
  });
});

describe("the preview card", () => {
  it("shows the page's picture, title, description and site, asking once per link", async () => {
    const request = vi.spyOn(api, "request").mockResolvedValue({
      preview: {
        url: "https://example.com/a",
        title: "Un título",
        description: "Una descripción.",
        image: "https://example.com/cover.jpg",
        site: "example.com",
      },
    });
    const { container } = render(
      <>
        <LinkPreviewCard url="https://example.com/a" />
        <LinkPreviewCard url="https://example.com/a" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("Un título")).toHaveLength(2));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET", "/link-preview?url=https%3A%2F%2Fexample.com%2Fa");
    const card = container.querySelector("a[data-link-preview]")!;
    expect(card.getAttribute("href")).toBe("https://example.com/a");
    expect(card.querySelector("img")?.getAttribute("src")).toBe("https://example.com/cover.jpg");
    expect(card.textContent).toContain("Una descripción.");
  });

  it("draws nothing when the page has no preview", async () => {
    vi.spyOn(api, "request").mockResolvedValue({ preview: null });
    const { container } = render(<LinkPreviewCard url="https://example.com/none" />);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("above the composer: shows what the typed link will look like, and can be hidden", async () => {
    vi.spyOn(api, "request").mockResolvedValue({
      preview: { url: "https://example.com/a", title: "Un título", site: "example.com" },
    });
    render(<ComposerLinkPreview url="https://example.com/a" />);
    expect(screen.queryByLabelText("Link preview")).toBeNull(); // waits for the typing to pause
    await waitFor(
      () => expect(screen.getByLabelText("Link preview").textContent).toContain("Un título"),
      {
        timeout: 2000,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide the link preview" }));
    expect(screen.queryByLabelText("Link preview")).toBeNull();
  });
});
