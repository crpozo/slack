import type { ChannelImage, ChannelMediaWindow } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import { firstWindow, viewerImage, withNewer, withOlder } from "./gallery";

const img = (n: number): ChannelImage => ({
  channelId: "ch",
  sk: `${n}#M${n}`,
  messageId: `M${n}`,
  userId: "u",
  createdAt: n,
  imageAt: `${String(n).padStart(13, "0")}#M${n}`,
  position: 0,
  attachment: {
    key: `k${n}`,
    name: `${n}.png`,
    contentType: "image/png",
    size: 1,
    url: `https://s3/${n}?sig`,
    thumbUrl: `https://s3/${n}-t?sig`,
  },
});
const win = (from: number, to: number, at: number, more = { older: false, newer: false }) =>
  ({
    images: Array.from({ length: to - from + 1 }, (_, i) => img(from + i)),
    index: at - from,
    hasOlder: more.older,
    hasNewer: more.newer,
  }) satisfies ChannelMediaWindow;

describe("the viewer's list (Phase 61)", () => {
  it("the first window replaces the lone image, which keeps the URLs it has on screen", () => {
    const clicked = { ...viewerImage(img(5).attachment, img(5).imageAt), url: "blob:local" };
    const first = firstWindow(clicked, win(1, 9, 5));
    expect(first?.index).toBe(4);
    expect(first?.images).toHaveLength(9);
    expect(first?.images[4]?.url).toBe("blob:local");
    expect(first?.images[3]?.url).toBe("https://s3/4?sig");
  });

  it("a window without the clicked image (deleted) changes nothing", () => {
    const clicked = viewerImage(img(5).attachment);
    expect(firstWindow(clicked, { ...win(1, 9, 5), index: -1 })).toBeNull();
    expect(firstWindow(viewerImage(img(50).attachment), win(1, 9, 5))).toBeNull();
  });

  it("slides: older in front, newer behind, nothing twice", () => {
    const list = win(10, 12, 10).images.map((i) => viewerImage(i.attachment, i.imageAt));
    const older = withOlder(list, win(5, 12, 10));
    expect(older.map((i) => i.name)).toEqual([
      "5.png",
      "6.png",
      "7.png",
      "8.png",
      "9.png",
      "10.png",
      "11.png",
      "12.png",
    ]);
    const newer = withNewer(older, win(10, 15, 12));
    expect(newer.map((i) => i.name).slice(-4)).toEqual(["12.png", "13.png", "14.png", "15.png"]);
    expect(withOlder(list, { ...win(5, 12, 10), index: -1 })).toBe(list);
  });
});
