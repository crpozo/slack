import { THUMBNAIL_MAX_SIDE } from "@mindfultech/shared";

export interface Thumbnail {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  /** A downscaled copy, when the image was larger than `THUMBNAIL_MAX_SIDE` on a side. */
  thumbnail?: Thumbnail;
}

/** Longest-side fit: the size `width`×`height` scales to inside `max`×`max` (never upscaled). */
export function fitWithin(
  width: number,
  height: number,
  max = THUMBNAIL_MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Image types a canvas can decode in every browser we support; the rest get no preview. */
export function canThumbnail(contentType: string): boolean {
  return /^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(contentType);
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    // Respects EXIF orientation, so phone photos come out the right way up.
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't decode the image"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const dims = (img: ImageBitmap | HTMLImageElement) =>
  "naturalWidth" in img
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : { width: img.width, height: img.height };

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Measures an image and, when it's bigger than the preview size, renders a
 * `THUMBNAIL_MAX_SIDE` copy (WebP where the browser can encode it, JPEG
 * otherwise). Any failure means "no preview": the original still uploads.
 */
export async function describeImage(file: Blob): Promise<ImageInfo | null> {
  if (!canThumbnail(file.type) || typeof document === "undefined") return null;
  try {
    const img = await decode(file);
    const full = dims(img);
    const target = fitWithin(full.width, full.height);
    if (target.width === full.width && target.height === full.height) {
      if ("close" in img) img.close();
      return full;
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return full;
    ctx.drawImage(img, 0, 0, target.width, target.height);
    if ("close" in img) img.close();
    let blob = await toBlob(canvas, "image/webp", 0.82);
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", 0.85);
    if (!blob) return full;
    return { ...full, thumbnail: { blob, contentType: blob.type, ...target } };
  } catch {
    return null;
  }
}
