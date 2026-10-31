import { MAX_TASK_ATTACHMENTS, type Attachment } from "@mindfultech/shared";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  dropPlaceholder,
  fillPlaceholder,
  imageRef,
  insertBlock,
  pastedImages,
  pastedName,
  placeholder,
  referencedImages,
} from "../lib/taskText";
import { getDownloadUrl, uploadFile } from "../lib/upload";
import { useChat } from "../store";
import { Lightbox } from "./Lightbox";

let nextPasteId = 0;

/**
 * Paste an image into a task's description or notes (Phase 33). The image is
 * uploaded like any task file (the board's folder, its limits), becomes a file
 * of the task, and the text gets `![name](attachment:<key>)` where the caret
 * was. Meanwhile an "Uploading…" placeholder holds its place; a failed upload
 * takes it out again and says why. Text pastes are left alone.
 *
 * `apply` changes the field's text from what it is when the upload finishes
 * (the person may have typed meanwhile); `onUploaded` adds the file to the task.
 */
export function useImagePaste({
  boardId,
  attached,
  apply,
  onUploaded,
}: Readonly<{
  boardId: string;
  /** Files the task already has (each image counts toward `MAX_TASK_ATTACHMENTS`). */
  attached: number;
  apply: (change: (text: string) => string) => void;
  onUploaded: (file: Attachment) => void | Promise<void>;
}>) {
  const showToast = useChat((s) => s.showToast);
  const [pending, setPending] = useState(0);

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const images = pastedImages(e.clipboardData);
    if (images.length === 0) return; // text: the textarea pastes it as usual
    e.preventDefault();
    const room = MAX_TASK_ATTACHMENTS - attached - pending;
    if (room <= 0) {
      showToast(`A task can have at most ${MAX_TASK_ATTACHMENTS} attachments.`);
      return;
    }
    const files = images.slice(0, room).map((file) => {
      const name = pastedName(file);
      return {
        id: `p${(nextPasteId++).toString(36)}${Date.now().toString(36)}`,
        name,
        file: name === file.name ? file : new File([file], name, { type: file.type }),
      };
    });
    if (files.length < images.length) {
      showToast(`A task can have at most ${MAX_TASK_ATTACHMENTS} attachments.`);
    }

    const field = e.currentTarget;
    const { selectionStart, selectionEnd } = field;
    const block = files.map((f) => placeholder(f.id, f.name)).join("\n");
    let caret = 0;
    apply((text) => {
      const next = insertBlock(text, selectionStart, selectionEnd, block);
      caret = next.caret;
      return next.text;
    });
    // After React has put the new text in: the caret goes after what was pasted.
    requestAnimationFrame(() => field.setSelectionRange(caret, caret));

    setPending((n) => n + files.length);
    for (const { id, name, file } of files) {
      uploadFile(file, boardId)
        .then(async (uploaded) => {
          await onUploaded(uploaded);
          apply((text) => fillPlaceholder(text, id, imageRef(name, uploaded.key)));
        })
        .catch((err: unknown) => {
          apply((text) => dropPlaceholder(text, id));
          showToast(err instanceof Error ? err.message : `Couldn't upload ${name}.`);
        })
        .finally(() => setPending((n) => n - 1));
    }
  }

  return { onPaste, pending };
}

/** "Uploading 2 images…" under the field while pasted images are on their way. */
export function PasteStatus({ pending }: Readonly<{ pending: number }>) {
  if (pending === 0) return null;
  return (
    <p role="status" className="mt-1 flex items-center gap-1.5 text-xs text-ink-secondary">
      <span
        className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent"
        aria-hidden="true"
      />
      Uploading {pending === 1 ? "image" : `${pending} images`}…
    </p>
  );
}

/** One of the task's images, through a freshly signed link (thumbnail first, original on click). */
function TaskImage({ file, compact }: Readonly<{ file: Attachment; compact: boolean }>) {
  const previewKey = file.thumbKey ?? file.key;
  const [url, setUrl] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const showToast = useChat((s) => s.showToast);

  useEffect(() => {
    alive.current = true;
    getDownloadUrl(previewKey).then(
      (u) => alive.current && setUrl(u),
      () => alive.current && setFailed(true),
    );
    return () => {
      alive.current = false;
    };
  }, [previewKey]);

  const size = compact ? "h-14 w-20" : "max-h-72 max-w-full";
  if (failed) {
    return (
      <span className="inline-block rounded-md border border-line px-2 py-1 text-xs text-ink-secondary">
        🖼 {file.name}
      </span>
    );
  }
  if (!url) {
    return (
      <span
        className={`inline-block animate-pulse rounded-md bg-surface-hover ${compact ? "h-14 w-20" : "h-40 w-64"}`}
        aria-hidden="true"
      />
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation(); // a card opens its details otherwise
          getDownloadUrl(file.key).then(setViewing, (err: unknown) =>
            showToast(err instanceof Error ? err.message : "Couldn't open the image."),
          );
        }}
        className="inline-block cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={`View ${file.name}`}
      >
        <img
          src={url}
          alt={file.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`block rounded-md border border-line bg-surface-sidebar object-cover ${size} ${compact ? "" : "h-auto w-auto object-contain"}`}
          onError={() => setFailed(true)}
        />
      </button>
      {viewing && (
        <Lightbox
          src={viewing}
          placeholder={file.thumbKey ? url : undefined}
          name={file.name}
          fileKey={file.key}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

/**
 * The images a task's text refers to (`attachment:` references to its own
 * files): a strip of thumbnails on a card (`compact`, at most `max`), larger
 * previews under the field in the forms.
 */
export function TaskImages({
  text,
  attachments,
  compact = false,
  max = Infinity,
}: Readonly<{ text: string; attachments: Attachment[]; compact?: boolean; max?: number }>) {
  const images = referencedImages(text, attachments);
  if (images.length === 0) return null;
  const shown = images.slice(0, max);
  const more = images.length - shown.length;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${compact ? "mt-1.5" : "mt-2"}`}>
      {shown.map((file) => (
        <TaskImage key={file.key} file={file} compact={compact} />
      ))}
      {more > 0 && <span className="text-xs text-ink-secondary">+{more}</span>}
    </div>
  );
}
