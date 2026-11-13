import type { LinkPreview } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { loadLinkPreview } from "../lib/linkPreview";
import { CloseIcon, LinkIcon } from "./icons";

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

/**
 * The preview of the link being typed, above the composer: a compact row
 * (picture, title, a line of the description, the site) shown a moment after
 * the link is written, so you see what the message will show. ✕ hides it for
 * that link (the message still previews it once sent).
 */
export function ComposerLinkPreview({ url }: Readonly<{ url: string | null }>) {
  // Wait for the typing to pause: a half-written address isn't asked for.
  const [settled, setSettled] = useState<string | null>(null);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [noImage, setNoImage] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(url), 500);
    return () => clearTimeout(timer);
  }, [url]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setNoImage(false);
    if (settled) void loadLinkPreview(settled).then((p) => !cancelled && setPreview(p));
    return () => {
      cancelled = true;
    };
  }, [settled]);
  if (!url || !preview || settled !== url || hidden === url) return null;
  return (
    <div
      className="flex items-center gap-3 border-b border-line px-3 py-2"
      aria-label="Link preview"
      data-composer-link-preview={preview.site}
    >
      {preview.image && !noImage && (
        <img
          src={preview.image}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setNoImage(true)}
          className="h-14 w-14 shrink-0 rounded-lg bg-black/20 object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{preview.title}</p>
        {preview.description && (
          <p className="truncate text-[13px] text-ink-secondary">{preview.description}</p>
        )}
        <p className="truncate text-xs text-ink-secondary">{preview.site}</p>
      </div>
      <button
        type="button"
        onClick={() => setHidden(url)}
        aria-label="Hide the link preview"
        title="Hide the preview"
        className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
