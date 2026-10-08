import type { Attachment as AttachmentData } from "@mindfultech/shared";
import { useEffect, useState } from "react";
import { formatBytes, getDownloadUrl } from "../lib/upload";
import { useChat } from "../store";
import { DownloadIcon, FileIcon } from "./icons";

function ImageAttachment({ attachment }: { attachment: AttachmentData }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

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
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block max-w-full">
      <img
        src={url}
        alt={attachment.name}
        loading="lazy"
        className="max-h-attachment max-w-full rounded-lg border border-line object-contain"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

function FileAttachment({ attachment }: { attachment: AttachmentData }) {
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
      showToast(err instanceof Error ? err.message : "No se pudo descargar el archivo.");
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
        aria-label={`Descargar ${attachment.name}`}
        title="Descargar"
      >
        <DownloadIcon />
      </button>
    </div>
  );
}

export function Attachment({ attachment }: { attachment: AttachmentData }) {
  return attachment.contentType.startsWith("image/") ? (
    <ImageAttachment attachment={attachment} />
  ) : (
    <FileAttachment attachment={attachment} />
  );
}
