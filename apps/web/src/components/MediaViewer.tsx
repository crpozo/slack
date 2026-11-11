import type { Attachment } from "@mindfultech/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { firstWindow, viewerImage, withNewer, withOlder, type ViewerImage } from "../lib/gallery";
import { mediaApi } from "../lib/mediaApi";
import { Lightbox } from "./Lightbox";

interface MediaViewerProps {
  channelId: string;
  /** The clicked image's message in the gallery (`imageAtFor(createdAt, messageId)`). */
  around: string;
  attachment: Attachment;
  /** The original, already resolved by the thumbnail that was clicked. */
  src: string;
  /** The thumbnail on screen, shown while the original loads. */
  placeholder?: string;
  onClose: () => void;
}

/**
 * Phase 61: the conversation's images, one at a time. The clicked image
 * shows at once; the images around it (up to 15 on each side, the server's
 * sliding window over the sparse image index) arrive in the background and
 * fill the arrows. Reaching either end while the server says there are more
 * asks for the next window past it.
 *
 * ← / → step through, Esc closes (listened for on `window`, removed on
 * unmount); a tap beside the picture and ✕ close too (the `Lightbox`).
 */
export function MediaViewer({
  channelId,
  around,
  attachment,
  src,
  placeholder,
  onClose,
}: Readonly<MediaViewerProps>) {
  // One state: a window landing in front shifts the index with the list.
  const [{ images, index }, setGallery] = useState<{ images: ViewerImage[]; index: number }>(
    () => ({
      images: [
        {
          ...viewerImage(attachment, around),
          url: src,
          ...(placeholder && { thumbUrl: placeholder }),
        },
      ],
      index: 0,
    }),
  );
  const [more, setMore] = useState({ older: false, newer: false });
  const fetching = useRef<{ older: boolean; newer: boolean }>({ older: false, newer: false });

  // The first window, around the clicked image.
  useEffect(() => {
    let live = true;
    const clicked = images[0]!;
    mediaApi.media(channelId, around, attachment.key).then(
      (window) => {
        const first = live ? firstWindow(clicked, window) : null;
        if (!first) return;
        setGallery(first);
        setMore({ older: window.hasOlder, newer: window.hasNewer });
      },
      // No window: the viewer is just the image that was clicked.
      () => {},
    );
    return () => {
      live = false;
    };
    // Once per opening: the viewer is remounted for another image.
  }, []);

  // At an end with more beyond it: the next window, past that end.
  useEffect(() => {
    const atStart = index === 0 && more.older;
    const atEnd = index === images.length - 1 && more.newer;
    const side = atStart ? "older" : atEnd ? "newer" : null;
    if (!side || fetching.current[side]) return;
    const edge = images[side === "older" ? 0 : images.length - 1]!;
    if (!edge.imageAt) return;
    fetching.current[side] = true;
    let live = true;
    mediaApi
      .media(channelId, edge.imageAt, edge.key)
      .then(
        (window) => {
          if (!live) return;
          setGallery((g) => {
            if (side === "newer") return { ...g, images: withNewer(g.images, window) };
            const list = withOlder(g.images, window);
            return { images: list, index: g.index + (list.length - g.images.length) };
          });
          setMore((m) => ({
            ...m,
            [side]: window.index >= 0 && (side === "older" ? window.hasOlder : window.hasNewer),
          }));
        },
        () => live && setMore((m) => ({ ...m, [side]: false })),
      )
      .finally(() => {
        fetching.current[side] = false;
      });
    return () => {
      live = false;
    };
  }, [channelId, index, images, more]);

  // The neighbours' thumbnails, so stepping shows something at once.
  useEffect(() => {
    for (const img of [images[index - 1], images[index + 1]]) {
      const url = img?.thumbUrl ?? img?.url;
      if (url) new Image().src = url;
    }
  }, [images, index]);

  const prev = useCallback(
    () => setGallery((g) => ({ ...g, index: Math.max(0, g.index - 1) })),
    [],
  );
  const next = useCallback(
    () => setGallery((g) => ({ ...g, index: Math.min(g.images.length - 1, g.index + 1) })),
    [],
  );

  const keys = useRef({ prev, next, onClose });
  keys.current = { prev, next, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") keys.current.prev();
      else if (e.key === "ArrowRight") keys.current.next();
      else if (e.key === "Escape") keys.current.onClose();
      else return;
      // Escape: closed here, not by the dialog's own cancel too.
      e.preventDefault();
      e.stopPropagation();
    };
    // Capture: the viewer's dialog keeps its events to itself.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const current = images[index]!;
  const counter = `${index + 1} / ${images.length}${more.older || more.newer ? "+" : ""}`;
  return (
    <Lightbox
      src={current.url ?? current.thumbUrl ?? src}
      placeholder={current.url ? current.thumbUrl : undefined}
      name={current.name}
      fileKey={current.key}
      onClose={onClose}
      nav={{
        counter,
        ...(index > 0 && { onPrev: prev }),
        ...(index < images.length - 1 && { onNext: next }),
      }}
    />
  );
}
