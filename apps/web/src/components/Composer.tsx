import type { Attachment } from "@mindfultech/shared";
import { MAX_TEXT_LENGTH } from "@mindfultech/shared";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { ulid } from "ulid";
import { chat } from "../lib/chat";
import { formatBytes, MAX_SIZE_LABEL, uploadFile, validateFile } from "../lib/upload";
import { useChat } from "../store";
import { CloseIcon, FileIcon, PaperclipIcon, SendIcon } from "./icons";

interface Upload {
  id: string;
  file: File;
  progress: number;
  attachment?: Attachment;
  error?: string;
}

export interface ComposerHandle {
  addFiles: (files: FileList | File[]) => void;
}

interface ComposerProps {
  channelId: string;
  placeholder: string;
  disabled?: boolean;
}

const MAX_HEIGHT_PX = 200;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { channelId, placeholder, disabled = false },
  ref,
) {
  const showToast = useChat((s) => s.showToast);
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const ready = uploads.flatMap((u) => (u.attachment ? [u.attachment] : []));
  const canSend = !disabled && !uploading && (text.trim().length > 0 || ready.length > 0);

  // Auto-grow up to MAX_HEIGHT_PX.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const update = (id: string, patch: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  function addFiles(files: FileList | File[]) {
    if (disabled) return;
    for (const file of Array.from(files)) {
      const invalid = validateFile(file);
      if (invalid) {
        showToast(`${file.name}: ${invalid}`);
        continue;
      }
      const id = ulid();
      setUploads((list) => [...list, { id, file, progress: 0 }]);
      uploadFile(file, channelId, (progress) => update(id, { progress })).then(
        (attachment) => update(id, { attachment, progress: 1 }),
        (err: unknown) =>
          update(id, { error: err instanceof Error ? err.message : "Error al subir" }),
      );
    }
  }

  useImperativeHandle(ref, () => ({ addFiles }));

  function submit() {
    if (!canSend) return;
    chat.sendMessage(channelId, text.trim(), ready);
    setText("");
    setUploads((list) => list.filter((u) => !u.attachment));
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  }

  return (
    <div className="border-t border-line bg-surface px-3 pb-3 pt-2 sm:px-4">
      <div className="rounded-xl border border-line bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
        {uploads.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-b border-line p-2">
            {uploads.map((u) => (
              <li
                key={u.id}
                className={`relative flex w-52 items-center gap-2 overflow-hidden rounded-lg border bg-surface-sidebar px-2 py-1.5 ${
                  u.error ? "border-error" : "border-line"
                }`}
              >
                <FileIcon className="shrink-0 text-ink-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-ink" title={u.file.name}>
                    {u.file.name}
                  </p>
                  <p className="text-[11px] text-ink-secondary">
                    {u.error ??
                      (u.attachment
                        ? formatBytes(u.file.size)
                        : `${Math.round(u.progress * 100)} %`)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}
                  className="rounded p-0.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  aria-label={`Quitar ${u.file.name}`}
                >
                  <CloseIcon />
                </button>
                {!u.attachment && !u.error && (
                  <span
                    className="absolute bottom-0 left-0 h-0.5 bg-primary transition-all"
                    style={{ width: `${Math.round(u.progress * 100)}%` }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-1 p-1.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
            aria-label="Adjuntar archivo"
            title={`Adjuntar (máx. ${MAX_SIZE_LABEL})`}
          >
            <PaperclipIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            aria-label="Mensaje"
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-ink placeholder:text-ink-secondary/80 focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className="btn-primary h-9 w-9 p-0"
            aria-label="Enviar"
            title={uploading ? "Esperando a que terminen las subidas" : "Enviar (Enter)"}
          >
            <SendIcon />
          </button>
        </div>
      </div>
      <p className="mt-1 hidden px-1 text-[11px] text-ink-secondary sm:block">
        <b>Enter</b> envía · <b>Shift + Enter</b> nueva línea · **negrita** _cursiva_ `código`
      </p>
    </div>
  );
});
