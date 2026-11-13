import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getDownloadUrl } from "../lib/upload";
import { useChat } from "../store";
import { downloadAttachment } from "../lib/download";
import { CloseIcon, DownloadIcon, GlobeIcon } from "./icons";
import { useModalDialog } from "./Modal";
import { pdfRenderer, type PdfRenderer } from "../lib/pdf";

/** pdf.js and its viewer: only downloaded the first time a phone opens a PDF. */
const PdfPages = lazy(() => import("./PdfPages"));

interface PdfViewerProps {
  /** S3 key of the attachment; a fresh download URL is fetched each time the viewer opens. */
  fileKey: string;
  name: string;
  onClose: () => void;
  /** Which viewer to use; by default the device's best (`pdfRenderer`). */
  renderer?: PdfRenderer;
}

/**
 * Reads a PDF without leaving the app. Computers get the browser's own PDF
 * viewer in an iframe (paging, zoom, search and print come with it). Phones
 * and tablets get every page drawn on canvas with pdf.js (`PdfPages`): iOS
 * WebKit shows only the first page of a PDF in a frame, or freezes, above
 * all in the Home Screen app. New tab and Download are always next to the
 * name. The presigned URL serves the file inline with its stored type.
 */
export function PdfViewer({ fileKey, name, onClose, renderer: forced }: Readonly<PdfViewerProps>) {
  const dialog = useModalDialog(onClose);
  const notify = useChat((s) => s.showToast);
  const [renderer] = useState<PdfRenderer>(() => forced ?? pdfRenderer());
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
    // A plain dark backdrop, no blur: a blurred backdrop is redrawn on every frame the
    // PDF's own viewer scrolls (more so over a live call), and the screen flickers.
    <dialog
      ref={dialog}
      aria-label={name}
      data-renderer={renderer}
      className={`m-auto max-h-none max-w-none overflow-hidden border-line bg-surface-raised p-0 text-ink shadow-xl backdrop:bg-scrim/80 ${
        renderer === "canvas"
          ? // Phones: the whole screen (dvh: the visible height, past Safari's bars).
            "h-[100dvh] w-full sm:h-[92dvh] sm:w-[min(96vw,72rem)] sm:rounded-2xl sm:border"
          : "h-[92dvh] w-[min(96vw,72rem)] rounded-2xl border"
      }`}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 border-b border-line px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
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
          <button
            type="button"
            onClick={() => void downloadAttachment({ key: fileKey, name }, notify)}
            className={button}
            aria-label={`Download ${name}`}
            title="Download"
          >
            <DownloadIcon />
            <span className="hidden sm:inline">Download</span>
          </button>
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
          {url && !error && renderer === "canvas" && (
            <Suspense
              fallback={
                <div
                  className="absolute inset-0 animate-pulse bg-surface-hover"
                  aria-hidden="true"
                />
              }
            >
              <div className="absolute inset-0">
                <PdfPages url={url} name={name} onError={setError} />
              </div>
            </Suspense>
          )}
          {url && renderer === "native" && (
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
