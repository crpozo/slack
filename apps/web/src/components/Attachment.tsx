import type { Attachment as AttachmentData } from "@mindfultech/shared";
import { useEffect, useRef, useState } from "react";
import { formatBytes, getDownloadUrl } from "../lib/upload";
import { formatDuration } from "../lib/voice";
import { useChat } from "../store";
import { DownloadIcon, FileIcon, MicIcon } from "./icons";
import { Lightbox } from "./Lightbox";
import { PdfViewer } from "./PdfViewer";

function ImageAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDownloadUrl(attachment.key).then(
      (u) => !cancelled && setUrl(u),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [attachment.key]);

  if (failed) return <FileAttachment attachment={attachment} />;
  if (!url) {
    return (
      <div
        className="h-40 w-60 max-w-full animate-pulse rounded-lg bg-surface-hover"
        aria-hidden="true"
      />
    );
  }
  // Opens in the app's own viewer; the original is one click away (its Download button).
  return (
    <>
      <button
        type="button"
        onClick={() => setViewing(true)}
        className="inline-block max-w-full cursor-zoom-in rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={`View ${attachment.name}`}
      >
        <img
          src={url}
          alt={attachment.name}
          loading="lazy"
          className="max-h-attachment max-w-full rounded-lg border border-line object-contain"
          onError={() => setFailed(true)}
        />
      </button>
      {viewing && <Lightbox src={url} name={attachment.name} onClose={() => setViewing(false)} />}
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
 * expire after 5 minutes: if playback fails on an old one, fetch a fresh URL once.
 */
function AudioAttachment({ attachment }: Readonly<{ attachment: AttachmentData }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshed = useRef(false);
  const voice = attachment.name.startsWith("voice-");

  useEffect(() => {
    let cancelled = false;
    getDownloadUrl(attachment.key).then(
      (u) => !cancelled && setUrl(u),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [attachment.key]);

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
  if (attachment.contentType === "application/pdf" || /\.pdf$/i.test(attachment.name))
    return <PdfAttachment attachment={attachment} />;
  return <FileAttachment attachment={attachment} />;
}
