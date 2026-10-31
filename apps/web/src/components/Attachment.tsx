import type { Attachment as AttachmentData } from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { localPreview, releaseLocalPreview } from "../lib/outbox";
import { renderNotesMarkdown } from "../lib/markdown";
import { formatBytes, getDownloadUrl, isUsableUrl, rememberDownloadUrl } from "../lib/upload";
import { downloadAttachment } from "../lib/download";
import {
  clipSeconds,
  formatDuration,
  formatPlaybackRate,
  nextPlaybackRate,
  usePlaybackRate,
} from "../lib/voice";
import { useChat } from "../store";
import { DownloadIcon, FileIcon, MicIcon, PauseIcon, PlayIcon } from "./icons";
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
  // Just sent from here (Phase 39): the local copy shows until the S3 image has
  // loaded, so the confirmed message doesn't blink.
  const [url, setUrl] = useState<string | null>(
    () =>
      localPreview(previewKey) ??
      (isUsableUrl(attachment.thumbUrl ?? attachment.url)
        ? (attachment.thumbUrl ?? attachment.url)!
        : null),
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
      (u) => {
        if (cancelled) return;
        if (!localPreview(previewKey)) {
          setUrl(u);
          return;
        }
        // Swap only once the S3 image is in the cache, then free the local copy.
        const loader = new Image();
        // (If it can't load, the local copy stays: it's the same picture.)
        loader.onload = () => {
          if (cancelled) return;
          setUrl(u);
          releaseLocalPreview(attachment.key, attachment.thumbKey);
        };
        loader.src = u;
      },
      () => !cancelled && !localPreview(previewKey) && setFailed(true),
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
          fileKey={attachment.key}
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
 * Opens a file in a new tab (the browser shows or plays it), or in the
 * system browser from the desktop app. Must run in the click itself: the tab
 * is opened before the URL is known, so popup blockers allow it.
 */
export async function openAttachment(
  attachment: Pick<AttachmentData, "key" | "url">,
  notify: (message: string) => void,
): Promise<void> {
  if (isDesktopApp()) {
    // The desktop app hands it to the OS's browser (a tab here would trap it).
    try {
      await openExternal(await getDownloadUrl(attachment.key, attachment.url));
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

/** The player sounding right now: starting another one pauses it. */
let nowPlaying: HTMLAudioElement | null = null;

/**
 * Voice messages and other audio: our own controls over a hidden `<audio>`
 * (so the platform's lock-screen controls still work on phones). A round
 * Play/Pause, a progress bar to click, drag or arrow through, the time, and
 * the speed button (Phase 36): 1× → 1.5× → 2×, remembered on this device and
 * shared by every player. `defaultPlaybackRate` keeps the speed when a
 * refreshed link reloads the audio. One clip plays at a time.
 */
function AudioAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const { url, failed, onError } = usePlayableUrl(attachment);
  const voice = attachment.name.startsWith("voice-");
  const label = voice ? "Voice message" : attachment.name;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [rate, setRate] = usePlaybackRate();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(() => clipSeconds(NaN, attachment.durationMs));

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [rate, url]);

  // `timeupdate` comes a few times a second: follow the playhead every frame
  // while playing so the bar glides.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function follow() {
      if (audioRef.current) setPosition(audioRef.current.currentTime);
      frame = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(
    () => () => {
      if (nowPlaying === audioRef.current) nowPlaying = null;
    },
    [],
  );

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    // A rejected play() (an autoplay rule, a source swap) leaves it paused; the
    // element's own events keep the button right.
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  }

  function seek(seconds: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
    setPosition(seconds);
  }

  if (failed) return <FileAttachment attachment={attachment} />;
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const started = playing || position > 0;
  return (
    <div
      className="flex w-80 max-w-full items-center gap-2.5 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.03] p-2 pr-2.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_8px_24px_-12px_rgb(0_0_0/0.6)]"
      data-audio-player
    >
      {url ? (
        <>
          <audio
            ref={audioRef}
            preload="metadata"
            src={url}
            onError={onError}
            // A reload (fresh link) starts from the default rate; this is the chosen one.
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = rate;
              setDuration(clipSeconds(e.currentTarget.duration, attachment.durationMs));
            }}
            onDurationChange={(e) =>
              setDuration(clipSeconds(e.currentTarget.duration, attachment.durationMs))
            }
            onPlay={(e) => {
              if (nowPlaying && nowPlaying !== e.currentTarget) nowPlaying.pause();
              nowPlaying = e.currentTarget;
              setPlaying(true);
            }}
            onPause={(e) => {
              if (nowPlaying === e.currentTarget) nowPlaying = null;
              setPlaying(false);
              setPosition(e.currentTarget.currentTime);
            }}
            onTimeUpdate={(e) => !playing && setPosition(e.currentTarget.currentTime)}
            onEnded={(e) => {
              e.currentTarget.currentTime = 0;
              setPosition(0);
            }}
            className="hidden"
          >
            <track kind="captions" />
          </audio>
          <button
            type="button"
            onClick={toggle}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-lg text-on-primary shadow-[0_4px_14px_-4px_rgb(64_179_117/0.7)] transition-transform hover:brightness-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            aria-label={`${playing ? "Pause" : "Play"} ${label}`}
            data-audio-toggle={playing ? "pause" : "play"}
          >
            {playing ? <PauseIcon /> : <PlayIcon className="translate-x-px" />}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="relative flex h-4 items-center">
              <input
                type="range"
                min={0}
                max={duration || 0}
                step="any"
                value={Math.min(position, duration || 0)}
                onChange={(e) => seek(Number(e.target.value))}
                disabled={duration === 0}
                className="seek-range peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-default"
                aria-label={`Seek ${label}`}
                aria-valuetext={`${formatDuration(position * 1000)} of ${formatDuration(duration * 1000)}`}
              />
              <div className="relative h-1 w-full rounded-full bg-white/15 peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-primary"
                  style={{ width: `${progress}%` }}
                />
                <div
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]"
                  style={{ left: `${progress}%` }}
                  aria-hidden="true"
                />
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] leading-none text-ink-secondary">
              <MicIcon className="shrink-0 text-primary" />
              <span className="truncate">{label}</span>
              <span className="ml-auto shrink-0 tabular-nums" data-audio-time>
                {started
                  ? `${formatDuration(position * 1000)} / ${formatDuration(duration * 1000)}`
                  : formatDuration(duration * 1000)}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRate(nextPlaybackRate(rate))}
            className="h-7 min-w-[2.75rem] shrink-0 rounded-full bg-white/10 px-2 text-xs font-semibold tabular-nums text-ink hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Playback speed ${formatPlaybackRate(rate)}. Change speed`}
            title="Playback speed"
            data-playback-rate={rate}
          >
            {formatPlaybackRate(rate)}
          </button>
        </>
      ) : (
        <>
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/10" />
          <div className="h-1 flex-1 animate-pulse rounded-full bg-white/10" aria-hidden="true" />
        </>
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
