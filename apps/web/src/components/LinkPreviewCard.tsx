import type { LinkPreview } from "@mindfultech/shared";
import { memo, useEffect, useState } from "react";
import { openExternal } from "../lib/external";
import { fetchLinkPreview } from "../lib/linkPreviewApi";

/**
 * Phase 64: the card under a message with a link: the page's image, title,
 * description and site, in the glass style. Nothing shows until the server
 * answers, nor when the page has nothing to show; a broken image just goes.
 * The image loads from the site itself (https only, no referrer).
 */
export const LinkPreviewCard = memo(function LinkPreviewCard({ url }: Readonly<{ url: string }>) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setImageFailed(false);
    void fetchLinkPreview(url).then((p) => live && setPreview(p));
    return () => {
      live = false;
    };
  }, [url]);

  if (!preview) return null;
  const image = preview.image && !imageFailed ? preview.image : null;
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(preview.url);
      }}
      className="glass mt-1.5 flex max-w-md overflow-hidden rounded-xl border border-white/10 text-left shadow-sm transition hover:border-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      data-link-preview={preview.domain}
    >
      <span className="w-1 shrink-0 bg-primary/60" aria-hidden="true" />
      <span className="min-w-0 flex-1 px-3 py-2">
        <span className="block truncate text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
          {preview.siteName ?? preview.domain}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-sm font-semibold text-ink">
          {preview.title}
        </span>
        {preview.description && (
          <span className="mt-0.5 line-clamp-2 block text-xs text-ink-secondary">
            {preview.description}
          </span>
        )}
      </span>
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-auto w-24 shrink-0 self-stretch object-cover sm:w-28"
          onError={() => setImageFailed(true)}
        />
      )}
    </a>
  );
});
