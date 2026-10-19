import type { Attachment as AttachmentData } from "@mindfultech/shared";
import { useEffect, useRef, useState } from "react";
import { formatBytes, getDownloadUrl, isUsableUrl, rememberDownloadUrl } from "../lib/upload";
import { formatDuration } from "../lib/voice";
import { useChat } from "../store";
import { DownloadIcon, FileIcon, MicIcon } from "./icons";
import { Lightbox } from "./Lightbox";

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
  if (failed) return <FileAttachment attachment={attachment} />;
  if (!url) {
    return (
      <div
        className="max-w-full animate-pulse rounded-lg bg-surface-hover"
        style={
          size
            ? { aspectRatio: `${size.width} / ${size.height}`, width: size.width, maxHeight: 320 }
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
        className="inline-block max-w-full cursor-zoom-in rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={`View ${attachment.name}`}
      >
        <img
          src={url}
          alt={attachment.name}
          loading="lazy"
          decoding="async"
          width={size?.width}
          height={size?.height}
          className="max-h-attachment h-auto max-w-full rounded-lg border border-line object-contain"
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

function FileAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const showToast = useChat((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  async function download() {
    // Open the tab synchronously so the popup blocker allows it.
    const tab = window.open("about:blank", "_blank");
    setBusy(true);
    try {
      const url = await getDownloadUrl(attachment.key);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err) {
      tab?.close();
      showToast(err instanceof Error ? err.message : "Couldn't download the file.");
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
 * Voice messages and other audio: a native player, so it plays inline with the
 * platform's controls (lock-screen controls on phones included). Download URLs
 * expire after a few hours: if playback fails on an old one, fetch a fresh URL once.
 */
function AudioAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshed = useRef(false);
  const voice = attachment.name.startsWith("voice-");

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
        <audio
          controls
          preload="metadata"
          src={url}
          onError={onError}
          className="h-10 w-full"
          aria-label={voice ? "Voice message" : attachment.name}
        >
          <track kind="captions" />
        </audio>
      ) : (
        <div
          className="h-10 w-full animate-pulse rounded-full bg-surface-hover"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function Attachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  if (attachment.contentType.startsWith("image/"))
    return <ImageAttachment attachment={attachment} />;
  if (attachment.contentType.startsWith("audio/"))
    return <AudioAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
}
