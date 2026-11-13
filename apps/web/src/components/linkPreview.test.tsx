// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tasksApi", () => ({ request: vi.fn() }));
vi.mock("../lib/external", () => ({ openExternal: vi.fn() }));
import { openExternal } from "../lib/external";
import { fetchLinkPreview, resetLinkPreviews } from "../lib/linkPreviewApi";
import { request } from "../lib/tasksApi";
import { LinkPreviewCard } from "./LinkPreviewCard";

const api = vi.mocked(request);
const preview = {
  url: "https://acme.example/post",
  title: "Acme launches Zeta",
  description: "A cheaper model.",
  image: "https://acme.example/card.png",
  siteName: "Acme Blog",
  domain: "acme.example",
};

beforeEach(() => resetLinkPreviews());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("link preview cards (Phase 64)", () => {
  it("shows the image, site, title and description once the server answers", async () => {
    api.mockResolvedValue({ preview });
    render(<LinkPreviewCard url="https://acme.example/post" />);
    const card = await screen.findByText("Acme launches Zeta");
    const link = card.closest("a")!;
    expect(link.className).toMatch(/glass/);
    expect(screen.getByText("Acme Blog")).toBeTruthy();
    expect(screen.getByText("A cheaper model.")).toBeTruthy();
    const img = link.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(preview.image);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(api).toHaveBeenCalledWith(
      "GET",
      `/utils/link-preview?url=${encodeURIComponent("https://acme.example/post")}`,
    );
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith(preview.url);
  });

  it("nothing at all when the page has nothing to show; a broken image just goes", async () => {
    api.mockResolvedValueOnce({ preview: null });
    const { container } = render(<LinkPreviewCard url="https://empty.example/" />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(container.querySelector("a")).toBeNull();
    cleanup();
    api.mockResolvedValueOnce({ preview });
    render(<LinkPreviewCard url="https://acme.example/post" />);
    const img = (await screen.findByText("Acme launches Zeta")).closest("a")!.querySelector("img")!;
    fireEvent.error(img);
    expect(screen.getByText("Acme launches Zeta").closest("a")!.querySelector("img")).toBeNull();
  });

  it("asks once per link; a failure is asked again next time", async () => {
    api.mockResolvedValue({ preview });
    await Promise.all([
      fetchLinkPreview("https://a.example"),
      fetchLinkPreview("https://a.example"),
    ]);
    expect(api).toHaveBeenCalledTimes(1);
    api.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchLinkPreview("https://b.example")).toBeNull();
    api.mockResolvedValue({ preview });
    expect(await fetchLinkPreview("https://b.example")).toEqual(preview);
  });
});
