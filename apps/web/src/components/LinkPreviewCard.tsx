import type { LinkPreview } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { loadLinkPreview } from "../lib/linkPreview";
import { LinkIcon } from "./icons";

/**
 * Phase 63: a shared link's page under the message, as chat apps show it:
 * its picture, title, a few lines of its description and the site. Nothing
 * is drawn while it loads or when the page has no preview.
 */
export function LinkPreviewCard({ url }: Readonly<{ url: string }>) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [noImage, setNoImage] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setNoImage(false);
    void loadLinkPreview(url).then((p) => !cancelled && setPreview(p));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!preview) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 block w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface-sidebar transition hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-link-preview={preview.site}
    >
      {preview.image && !noImage && (
        <img
          src={preview.image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setNoImage(true)}
          className="aspect-[1.91/1] w-full bg-black/20 object-cover"
        />
      )}
      <span className="flex flex-col gap-1 px-3 py-2.5">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-ink">
          {preview.title}
        </span>
        {preview.description && (
          <span className="line-clamp-3 text-[13px] leading-relaxed text-ink-secondary">
            {preview.description}
          </span>
        )}
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-secondary">
          <LinkIcon aria-hidden="true" />
          <span className="truncate">{preview.site}</span>
        </span>
      </span>
    </a>
  );
}
