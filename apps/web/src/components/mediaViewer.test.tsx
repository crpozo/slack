// @vitest-environment jsdom
import type { ChannelImage, ChannelMediaWindow } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/mediaApi", () => ({ mediaApi: { media: vi.fn() } }));
import { mediaApi } from "../lib/mediaApi";
import { MediaViewer } from "./MediaViewer";

const api = vi.mocked(mediaApi);
const img = (n: number): ChannelImage => ({
  channelId: "ch_general",
  sk: `${n}#M${n}`,
  messageId: `M${n}`,
  userId: "u",
  createdAt: n,
  imageAt: `${String(n).padStart(13, "0")}#M${n}`,
  position: 0,
  attachment: {
    key: `attachments/ch_general/${n}.png`,
    name: `${n}.png`,
    contentType: "image/png",
    size: 1,
    url: `https://s3.example/${n}.png?sig`,
  },
});
const page = (from: number, to: number, at: number, more = false): ChannelMediaWindow => ({
  images: Array.from({ length: to - from + 1 }, (_, i) => img(from + i)),
  index: at - from,
  hasOlder: more,
  hasNewer: more,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(onClose = vi.fn()) {
  const clicked = img(5);
  render(
    <MediaViewer
      channelId="ch_general"
      around={clicked.imageAt}
      attachment={clicked.attachment}
      src="blob:the-original"
      onClose={onClose}
    />,
  );
  return onClose;
}
const shown = () => screen.getByRole("img", { name: /\.png$/ }).getAttribute("src");
const counter = () => screen.getByTestId("media-counter").textContent;

describe("MediaViewer (Phase 61)", () => {
  it("shows the clicked image at once, then fills the arrows from the window around it", async () => {
    let answer!: (w: ChannelMediaWindow) => void;
    api.media.mockReturnValue(new Promise((r) => (answer = r)));
    open();
    expect(shown()).toBe("blob:the-original");
    expect(counter()).toBe("1 / 1");
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(api.media).toHaveBeenCalledWith(
      "ch_general",
      img(5).imageAt,
      "attachments/ch_general/5.png",
    );
    await act(async () => answer(page(2, 8, 5)));
    expect(counter()).toBe("4 / 7");
    // Still the same picture (no reload of what was on screen).
    expect(shown()).toBe("blob:the-original");
  });

  it("← and → step through, the arrows too; Esc closes", async () => {
    api.media.mockResolvedValue(page(2, 8, 5));
    const onClose = open();
    await waitFor(() => expect(counter()).toBe("4 / 7"));
    fireEvent.keyDown(window_(), { key: "ArrowRight" });
    expect(counter()).toBe("5 / 7");
    expect(shown()).toBe("https://s3.example/6.png?sig");
    fireEvent.keyDown(window_(), { key: "ArrowLeft" });
    fireEvent.keyDown(window_(), { key: "ArrowLeft" });
    expect(counter()).toBe("3 / 7");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(counter()).toBe("4 / 7");
    fireEvent.keyDown(window_(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the ✕ closes; the keyboard listener goes away with the viewer", async () => {
    api.media.mockResolvedValue(page(5, 5, 5));
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const onClose = open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    onClose.mockClear();
    fireEvent.keyDown(window_(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("at an end with more beyond it, asks for the next window past it", async () => {
    api.media.mockResolvedValueOnce(page(5, 7, 5, true));
    api.media.mockResolvedValueOnce(page(1, 5, 5, false));
    open();
    await waitFor(() => expect(api.media).toHaveBeenCalledTimes(2));
    expect(api.media).toHaveBeenLastCalledWith(
      "ch_general",
      img(5).imageAt,
      "attachments/ch_general/5.png",
    );
    await waitFor(() => expect(counter()).toMatch(/^5 \/ 7/));
  });
});

const window_ = () => globalThis.window;
