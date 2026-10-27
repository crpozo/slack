import { chat } from "../lib/chat";
import { outbox, useUploadState, type UploadTask } from "../lib/outbox";
import { formatBytes } from "../lib/upload";
import { formatDuration } from "../lib/voice";
import type { ChatMessage } from "../store";
import { FileIcon, MicIcon } from "./icons";

// ---------------------------------------------------------------------------
// A message on its way (Phase 39): its files as they go up, shown from the
// local copies they were sent from, and "Sending…" / "Failed to send".
// ---------------------------------------------------------------------------

/** A thin bar along the bottom of a file while it uploads. */
function ProgressBar({ name, progress }: Readonly<{ name: string; progress: number }>) {
  const percent = Math.round(progress * 100);
  return (
    <span
      role="progressbar"
      aria-label={`Uploading ${name}`}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className="absolute inset-x-0 bottom-0 h-1 bg-black/30"
    >
      <span
        className="block h-full bg-primary transition-[width] duration-200"
        style={{ width: `${Math.max(3, percent)}%` }}
      />
    </span>
  );
}

function OutgoingFile({ task }: Readonly<{ task: UploadTask }>) {
  const { progress, attachment, error } = useUploadState(task);
  const uploading = !attachment && !error;
  const { file } = task;
  const border = error ? "border-error" : "border-line";

  if (task.previewUrl) {
    // Same box as the image it becomes, so nothing jumps when it's confirmed.
    return (
      <span className={`relative inline-block max-w-full overflow-hidden rounded-lg sm:max-w-sm`}>
        <img
          src={task.previewUrl}
          alt={file.name}
          className={`block h-auto max-h-attachment w-auto max-w-full rounded-lg border bg-surface-sidebar object-contain sm:max-w-sm ${border}`}
          data-outgoing-image
        />
        {uploading && <ProgressBar name={file.name} progress={progress} />}
      </span>
    );
  }

  const voice = task.extra.durationMs !== undefined;
  return (
    <span
      className={`relative flex w-72 max-w-full items-center gap-3 overflow-hidden rounded-lg border bg-surface p-2.5 ${border}`}
      data-outgoing-file
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-hover text-lg text-ink-secondary">
        {voice ? <MicIcon /> : <FileIcon />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {voice ? "Voice message" : file.name}
        </span>
        <span className="block text-xs text-ink-secondary">
          {voice ? formatDuration(task.extra.durationMs!) : formatBytes(file.size)}
          {uploading && ` · ${Math.round(progress * 100)} %`}
        </span>
      </span>
      {uploading && <ProgressBar name={file.name} progress={progress} />}
    </span>
  );
}

/** The files of a message not confirmed yet, from their local copies. */
export function OutgoingFiles({ message }: Readonly<{ message: ChatMessage }>) {
  const files = outbox.files(message.clientId);
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {files.map((task) => (
        <OutgoingFile key={task.id} task={task} />
      ))}
    </div>
  );
}

/** Under a message on its way: "Sending…", or "Failed to send" with the retry. */
export function SendStatus({ message }: Readonly<{ message: ChatMessage }>) {
  if (message.status === "pending") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-secondary" role="status">
        <span
          className="h-3 w-3 animate-spin rounded-full border-2 border-ink-secondary/40 border-t-ink-secondary motion-reduce:animate-none"
          aria-hidden="true"
        />
        Sending…
      </p>
    );
  }
  if (message.status !== "failed") return null;
  return (
    <button
      type="button"
      onClick={() => chat.retry(message)}
      className="mt-1 flex items-center gap-2 rounded text-xs text-error hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      data-retry
    >
      <span className="h-1.5 w-1.5 rounded-full bg-error" aria-hidden="true" />
      Failed to send · Click to retry
    </button>
  );
}
