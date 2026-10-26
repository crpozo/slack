import type { Attachment as AttachmentData } from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { renderNotesMarkdown } from "../lib/markdown";
import { formatBytes, getDownloadUrl, isUsableUrl, rememberDownloadUrl } from "../lib/upload";
import {
  formatDuration,
  formatPlaybackRate,
  nextPlaybackRate,
  usePlaybackRate,
} from "../lib/voice";
import { useChat } from "../store";
import { DownloadIcon, FileIcon, MicIcon } from "./icons";
import { Lightbox } from "./Lightbox";
import { PdfViewer } from "./PdfViewer";

/**
 * Image previews are compact and standard, like Slack's: never wider than
 * `PREVIEW_MAX_WIDTH` nor taller than `PREVIEW_MAX_HEIGHT` (the `attachment`
 * height token), aspect kept, whatever the monitor. The original opens in
 * the lightbox.
 */
export const PREVIEW_MAX_WIDTH = 384; // Tailwind `max-w-sm`
export const PREVIEW_MAX_HEIGHT = 300;

/** The preview's box for an image of `width`×`height`: scaled down to fit, never up. */
export function previewBox(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The preview's box: the thumbnail's size, capped by the usual max height/width via CSS. */
function previewSize(a: AttachmentData): { width: number; height: number } | null {
  return a.width && a.height ? { width: a.width, height: a.height } : null;
}

function ImageAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const previewKey = attachment.thumbKey ?? attachment.key;
  const [url, setUrl] = useState<string | null>(() =>
    isUsableUrl(attachment.thumbUrl ?? attachment.url)
      ? (attachment.thumbUrl ?? attachment.url)!
      : null,
  );
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const showToast = useChat((s) => s.showToast);

  // URLs the server attached to the message are good for hours; keep them for later lookups.
  useEffect(() => {
    rememberDownloadUrl(attachment.key, attachment.url);
    if (attachment.thumbKey) rememberDownloadUrl(attachment.thumbKey, attachment.thumbUrl);
  }, [attachment.key, attachment.url, attachment.thumbKey, attachment.thumbUrl]);

  useEffect(() => {
    let cancelled = false;
    getDownloadUrl(previewKey, attachment.thumbKey ? attachment.thumbUrl : attachment.url).then(
      (u) => !cancelled && setUrl(u),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [previewKey, attachment.thumbKey, attachment.thumbUrl, attachment.url]);

  async function view() {
    try {
      // The viewer gets the original; the thumbnail stands in while it loads.
      setViewing(await getDownloadUrl(attachment.key, attachment.url));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't open the image.");
    }
  }

  const size = previewSize(attachment);
  const box = size ? previewBox(size.width, size.height) : null;
  if (failed) return <FileAttachment attachment={attachment} />;
  if (!url) {
    // Reserves the preview's final box, so nothing jumps when it loads.
    return (
      <div
        className="max-w-full animate-pulse rounded-lg bg-surface-hover"
        style={
          box
            ? { aspectRatio: `${box.width} / ${box.height}`, width: box.width }
            : { width: 240, height: 160 }
        }
        aria-hidden="true"
      />
    );
  }
  // Opens in the app's own viewer; the original is one click away (its Download button).
  return (
    <>
      <button
        type="button"
        onClick={() => void view()}
        className="inline-block max-w-full cursor-zoom-in rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary sm:max-w-sm"
        aria-label={`View ${attachment.name}`}
      >
        <img
          src={url}
          alt={attachment.name}
          loading="lazy"
          decoding="async"
          width={box?.width}
          height={box?.height}
          className="block h-auto max-h-attachment w-auto max-w-full rounded-lg border border-line bg-surface-sidebar object-contain sm:max-w-sm"
          onError={() => setFailed(true)}
        />
      </button>
      {viewing && (
        <Lightbox
          src={viewing}
          placeholder={attachment.thumbKey ? url : undefined}
          name={attachment.name}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

/** A PDF opens in the app's own viewer; its menu still downloads it. */
function PdfAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const [viewing, setViewing] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setViewing(true)}
        className="flex w-72 max-w-full items-center gap-3 rounded-lg border border-line bg-surface p-2.5 text-left hover:border-primary hover:bg-surface-hover"
        aria-label={`Open ${attachment.name}`}
        title="Open"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-error/15 text-[10px] font-bold text-error">
          PDF
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{attachment.name}</span>
          <span className="block text-xs text-ink-secondary">
            {formatBytes(attachment.size)} · Click to read
          </span>
        </span>
      </button>
      {viewing && (
        <PdfViewer
          fileKey={attachment.key}
          name={attachment.name}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
}

/**
 * Opens a file in a new tab (the browser shows or downloads it), or in the
 * system browser from the desktop app. Must run in the click itself: the tab
 * is opened before the URL is known, so popup blockers allow it.
 */
export async function downloadAttachment(
  attachment: Pick<AttachmentData, "key" | "url">,
  notify: (message: string) => void,
): Promise<void> {
  if (isDesktopApp()) {
    // The desktop app hands it to the OS's browser (a tab here would trap it).
    try {
      await openExternal(await getDownloadUrl(attachment.key, attachment.url), { notify });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't download the file.");
    }
    return;
  }
  const tab = window.open("about:blank", "_blank");
  try {
    const url = await getDownloadUrl(attachment.key, attachment.url);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (err) {
    tab?.close();
    notify(err instanceof Error ? err.message : "Couldn't download the file.");
  }
}

function FileAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const showToast = useChat((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      await downloadAttachment(attachment, showToast);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-72 max-w-full items-center gap-3 rounded-lg border border-line bg-surface p-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky/30 text-ink">
        <FileIcon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink" title={attachment.name}>
          {attachment.name}
        </p>
        <p className="text-xs text-ink-secondary">{formatBytes(attachment.size)}</p>
      </div>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
        aria-label={`Download ${attachment.name}`}
        title="Download"
      >
        <DownloadIcon />
      </button>
    </div>
  );
}

/**
 * The download URL a native `<audio>`/`<video>` plays from. URLs expire after
 * a few hours: if playback fails on an old one (`onError`), fetch a fresh URL
 * once; a second failure (or no URL at all) sets `failed`.
 */
function usePlayableUrl(attachment: AttachmentData) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    rememberDownloadUrl(attachment.key, attachment.url);
    getDownloadUrl(attachment.key, attachment.url).then(
      (u) => !cancelled && setUrl(u),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [attachment.key, attachment.url]);

  function onError() {
    if (refreshed.current) return setFailed(true);
    refreshed.current = true;
    getDownloadUrl(attachment.key).then(setUrl, () => setFailed(true));
  }

  return { url, failed, onError };
}

/**
 * Voice messages and other audio: a native player, so it plays inline with the
 * platform's controls (lock-screen controls on phones included), plus a speed
 * button (Phase 36): 1× → 1.5× → 2×, remembered on this device and shared by
 * every player. `defaultPlaybackRate` keeps the speed when a refreshed link
 * reloads the audio.
 */
function AudioAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const { url, failed, onError } = usePlayableUrl(attachment);
  const voice = attachment.name.startsWith("voice-");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [rate, setRate] = usePlaybackRate();

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [rate, url]);

  if (failed) return <FileAttachment attachment={attachment} />;
  return (
    <div className="flex w-80 max-w-full flex-col gap-1 rounded-2xl border border-line bg-surface p-2">
      <p className="flex items-center gap-1.5 px-1 text-xs text-ink-secondary">
        <MicIcon className="text-primary" />
        <span className="truncate">{voice ? "Voice message" : attachment.name}</span>
        {attachment.durationMs !== undefined && (
          <span className="ml-auto tabular-nums">{formatDuration(attachment.durationMs)}</span>
        )}
      </p>
      {url ? (
        <div className="flex items-center gap-1.5">
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            src={url}
            onError={onError}
            // A reload (fresh link) starts from the default rate; this is the chosen one.
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = rate;
            }}
            className="h-10 min-w-0 flex-1"
            aria-label={voice ? "Voice message" : attachment.name}
          >
            <track kind="captions" />
          </audio>
          <button
            type="button"
            onClick={() => setRate(nextPlaybackRate(rate))}
            className="h-8 w-12 shrink-0 rounded-full border border-line text-xs font-semibold tabular-nums text-ink hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Playback speed ${formatPlaybackRate(rate)}. Change speed`}
            title="Playback speed"
            data-playback-rate={rate}
          >
            {formatPlaybackRate(rate)}
          </button>
        </div>
      ) : (
        <div
          className="h-10 w-full animate-pulse rounded-full bg-surface-hover"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/**
 * Videos play inline with the browser's controls, compact (`max-w-md`) so a
 * clip never takes over the conversation; only metadata loads until played.
 * Like audio, an expired URL gets one fresh one; a format the browser can't
 * play (a `.mov` in Chrome, say) falls back to the download card.
 */
function VideoAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const { url, failed, onError } = usePlayableUrl(attachment);

  if (failed) return <FileAttachment attachment={attachment} />;
  if (!url) {
    return (
      <div
        className="aspect-video w-full max-w-md animate-pulse rounded-lg bg-surface-hover"
        aria-hidden="true"
      />
    );
  }
  return (
    <video
      controls
      playsInline
      preload="metadata"
      src={url}
      onError={onError}
      className="block max-h-attachment w-full max-w-md rounded-lg border border-line bg-black"
      aria-label={attachment.name}
    >
      <track kind="captions" />
    </video>
  );
}

/** Markdown files up to this size are read inline; bigger ones are just a download. */
export const MAX_INLINE_MARKDOWN_BYTES = 100 * 1024;

/**
 * A small Markdown document: its download card, plus "Preview" that fetches
 * the text and shows it rendered in a collapsible block, with the same
 * renderer as AI call notes (headings, lists, quotes, code), which escapes
 * everything before adding its own tags. Fetched only on the first expand.
 */
function MarkdownAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const html = useMemo(() => (text === null ? "" : renderNotesMarkdown(text)), [text]);

  useEffect(() => {
    if (!open || text !== null) return;
    const controller = new AbortController();
    setError(null);
    getDownloadUrl(attachment.key, attachment.url)
      .then((url) => fetch(url, { signal: controller.signal }))
      .then((res) => {
        if (!res.ok) throw new Error(`Couldn't load the document (${res.status}).`);
        return res.text();
      })
      .then(setText, (err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Couldn't load the document.");
      });
    return () => controller.abort();
  }, [open, text, attachment.key, attachment.url]);

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5">
      <FileAttachment attachment={attachment} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="self-start rounded-md px-1 text-xs font-medium text-primary hover:underline"
        aria-expanded={open}
      >
        {open ? "Hide preview" : "Preview document"}
      </button>
      {open && (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-line bg-surface-sidebar p-3">
          {error ? (
            <p className="text-sm text-error">{error}</p>
          ) : text === null ? (
            <p className="text-sm text-ink-secondary">Loading…</p>
          ) : (
            <div
              className="md md-notes break-words text-sm leading-relaxed text-ink"
              // Safe: renderNotesMarkdown escapes all text before adding its own tags.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      )}
    </div>
  );
}

export type AttachmentKind = "image" | "audio" | "video" | "pdf" | "markdown" | "file";

/** How an attachment shows in a message (by type, or by extension when the type is vague). */
export function attachmentKind(
  a: Pick<AttachmentData, "contentType" | "name" | "size">,
): AttachmentKind {
  const type = a.contentType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf" || /\.pdf$/i.test(a.name)) return "pdf";
  // Browsers upload `.md` as text/markdown, text/x-markdown or nothing at all.
  if (
    (type.includes("markdown") || /\.(md|markdown)$/i.test(a.name)) &&
    a.size <= MAX_INLINE_MARKDOWN_BYTES
  ) {
    return "markdown";
  }
  return "file";
}

export function Attachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  switch (attachmentKind(attachment)) {
    case "image":
      return <ImageAttachment attachment={attachment} />;
    case "audio":
      return <AudioAttachment attachment={attachment} />;
    case "video":
      return <VideoAttachment attachment={attachment} />;
    case "pdf":
      return <PdfAttachment attachment={attachment} />;
    case "markdown":
      return <MarkdownAttachment attachment={attachment} />;
    default:
      return <FileAttachment attachment={attachment} />;
  }
}
