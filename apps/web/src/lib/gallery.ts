import type { Attachment, ChannelMediaWindow } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// Phase 61: the image viewer's list. It starts as the one image that was
// clicked and grows by the server's sliding windows (`GET /channels/{id}/
// media`, at most 15 images on each side of the one asked about): the first
// around the clicked image, then one more past whichever end the viewer
// reaches while the server says there are more.
// ---------------------------------------------------------------------------

export interface ViewerImage {
  /** The attachment's key: unique, and what the server is asked "around". */
  key: string;
  name: string;
  /** The original (signed), and the thumbnail shown while it loads. */
  url?: string;
  thumbUrl?: string;
  /** Its message's place in the gallery; absent for an image only known locally. */
  imageAt?: string;
  attachment: Attachment;
}

export const viewerImage = (attachment: Attachment, imageAt?: string): ViewerImage => ({
  key: attachment.key,
  name: attachment.name,
  ...(attachment.url && { url: attachment.url }),
  ...(attachment.thumbUrl && { thumbUrl: attachment.thumbUrl }),
  ...(imageAt && { imageAt }),
  attachment,
});

export const windowImages = (window: ChannelMediaWindow): ViewerImage[] =>
  window.images.map((img) => viewerImage(img.attachment, img.imageAt));

/**
 * The first window, around the clicked image (`index` in the window). The
 * clicked image keeps the URLs it already has on screen, so nothing reloads.
 * `null` when the window doesn't hold it (deleted since): the viewer then
 * stays on the one image.
 */
export function firstWindow(
  clicked: ViewerImage,
  window: ChannelMediaWindow,
): { images: ViewerImage[]; index: number } | null {
  if (window.index < 0 || window.images[window.index]?.attachment.key !== clicked.key) return null;
  const images = windowImages(window);
  images[window.index] = { ...images[window.index]!, ...pick(clicked) };
  return { images, index: window.index };
}

const pick = (img: ViewerImage) => ({
  ...(img.url && { url: img.url }),
  ...(img.thumbUrl && { thumbUrl: img.thumbUrl }),
});

/** `images` with a window fetched around its first image: what is older goes in front. */
export function withOlder(images: ViewerImage[], window: ChannelMediaWindow): ViewerImage[] {
  if (window.index < 0) return images;
  const known = new Set(images.map((i) => i.key));
  const older = windowImages(window)
    .slice(0, window.index)
    .filter((i) => !known.has(i.key));
  return [...older, ...images];
}

/** `images` with a window fetched around its last image: what is newer goes behind. */
export function withNewer(images: ViewerImage[], window: ChannelMediaWindow): ViewerImage[] {
  if (window.index < 0) return images;
  const known = new Set(images.map((i) => i.key));
  const newer = windowImages(window)
    .slice(window.index + 1)
    .filter((i) => !known.has(i.key));
  return [...images, ...newer];
}
