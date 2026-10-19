import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getDownloadUrl } from "../lib/upload";
import { CloseIcon, DownloadIcon, GlobeIcon } from "./icons";
import { useModalDialog } from "./Modal";

interface PdfViewerProps {
  /** S3 key of the attachment; a fresh download URL is fetched each time the viewer opens. */
  fileKey: string;
  name: string;
  onClose: () => void;
}

/**
 * Reads a PDF without leaving the app: a large modal with the browser's own
 * PDF viewer in an iframe (paging, zoom and search come with it; nothing to
 * ship). The presigned URL serves the file inline with its stored type.
 * iOS Safari only shows the first page in a frame, so there's always "Open in
 * a new tab" and Download next to the name.
 */
export function PdfViewer({ fileKey, name, onClose }: Readonly<PdfViewerProps>) {
  const dialog = useModalDialog(onClose);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDownloadUrl(fileKey).then(
      (u) => !cancelled && setUrl(u),
      (err: unknown) =>
        !cancelled && setError(err instanceof Error ? err.message : "Couldn't load the file."),
    );
    return () => {
      cancelled = true;
    };
  }, [fileKey]);

  const button =
    "flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-40";

  return createPortal(
    <dialog
      ref={dialog}
      aria-label={name}
      className="m-auto h-[92vh] max-h-none w-[min(96vw,72rem)] max-w-none overflow-hidden rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-xl backdrop:bg-scrim/60 backdrop:backdrop-blur-sm"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 border-b border-line px-3 py-2">
          <p className="mr-auto min-w-0 truncate text-sm font-medium" title={name}>
            {name}
          </p>
          <a
            href={url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={`${button} ${url ? "" : "pointer-events-none opacity-40"}`}
            aria-disabled={!url}
            title="Open in a new tab"
          >
            <GlobeIcon />
            <span className="hidden sm:inline">New tab</span>
          </a>
          <a
            href={url ?? undefined}
            download={name}
            className={`${button} ${url ? "" : "pointer-events-none opacity-40"}`}
            aria-disabled={!url}
            aria-label={`Download ${name}`}
            title="Download"
          >
            <DownloadIcon />
            <span className="hidden sm:inline">Download</span>
          </a>
          <button
            type="button"
            className={`${button} px-2`}
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="relative min-h-0 flex-1 bg-surface-sidebar">
          {error && (
            <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-secondary">
              {error}
            </p>
          )}
          {!url && !error && (
            <div className="absolute inset-0 animate-pulse bg-surface-hover" aria-hidden="true" />
          )}
          {url && (
            <iframe
              src={url}
              title={name}
              // No `sandbox`: Chrome's PDF viewer doesn't run in a sandboxed frame. The file
              // is cross-origin (S3), so the frame can't reach the app anyway.
              className="h-full w-full border-0"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
