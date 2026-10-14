import type { Attachment } from "@mindfultech/shared";
import { MAX_TEXT_LENGTH } from "@mindfultech/shared";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { ulid } from "ulid";
import { useCall } from "../lib/call";
import { chat } from "../lib/chat";
import { mediaErrorText } from "../lib/media";
import {
  formatDuration,
  MAX_VOICE_MS,
  supportsVoiceMessages,
  useVoiceRecorder,
  type VoiceClip,
} from "../lib/voice";
import { formatBytes, MAX_SIZE_LABEL, uploadFile, validateFile } from "../lib/upload";
import { useChat, useNameOf } from "../store";
import { EmojiPicker } from "./EmojiPicker";
import {
  CloseIcon,
  FileIcon,
  MicIcon,
  PaperclipIcon,
  ReplyIcon,
  SendIcon,
  SmileIcon,
  TrashIcon,
} from "./icons";
import { Popover } from "./Popover";

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
/** Shorter recordings are a slip of the finger, not a message. */
const MIN_VOICE_MS = 500;

/** Replaces the input row while recording: red dot, timer, level, Cancel and Send. */
function RecordingBar({
  elapsed,
  level,
  sending,
  onCancel,
  onSend,
}: Readonly<{
  elapsed: number;
  level: number;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
}>) {
  return (
    <div className="flex flex-1 items-center gap-2 px-1" aria-live="polite">
      <button
        type="button"
        onClick={onCancel}
        disabled={sending}
        className="rounded-lg p-2 text-ink-secondary hover:bg-error/15 hover:text-error disabled:opacity-50"
        aria-label="Cancel recording"
        title="Cancel"
      >
        <TrashIcon />
      </button>
      <span
        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-error"
        aria-hidden="true"
      />
      <span className="w-12 shrink-0 font-mono text-sm tabular-nums text-ink">
        {formatDuration(elapsed)}
      </span>
      <span className="sr-only">{sending ? "Sending voice message" : "Recording"}</span>
      <span
        className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line"
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-100"
          style={{ width: `${Math.max(4, level * 100)}%` }}
        />
      </span>
      <span className="hidden text-xs text-ink-secondary sm:inline">
        max {formatDuration(MAX_VOICE_MS)}
      </span>
      <button
        type="button"
        onClick={onSend}
        disabled={sending}
        className="btn-primary h-9 w-9 shrink-0 p-0"
        aria-label="Send voice message"
        title="Send"
      >
        <SendIcon />
      </button>
    </div>
  );
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { channelId, placeholder, disabled = false },
  ref,
) {
  const showToast = useChat((s) => s.showToast);
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const replyTo = useChat((s) => s.replyTo[channelId]);
  const inCall = useCall((s) => s.call !== null);
  const voiceSupported = useMemo(supportsVoiceMessages, []);
  const [sendingVoice, setSendingVoice] = useState(false);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const nameOf = useNameOf();

  // Starting a reply (swipe, or Reply in the toolbar) puts the cursor here.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  /** Inserts at the caret (replacing any selection) and keeps focus in the textarea. */
  function insertAtCursor(snippet: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  }

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
          update(id, { error: err instanceof Error ? err.message : "Upload failed" }),
      );
    }
  }

  useImperativeHandle(ref, () => ({ addFiles }));

  const sendVoice = useCallback(
    async (clip: VoiceClip | null) => {
      if (!clip) return;
      if (clip.durationMs < MIN_VOICE_MS) {
        showToast("Too short: hold on a little longer.");
        return;
      }
      setSendingVoice(true);
      try {
        const attachment = await uploadFile(clip.file, channelId);
        chat.sendMessage(
          channelId,
          "",
          [{ ...attachment, durationMs: Math.max(1, Math.round(clip.durationMs)) }],
          useChat.getState().replyTo[channelId],
        );
        useChat.getState().setReplyTo(channelId, null);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Couldn't send the voice message.");
      } finally {
        setSendingVoice(false);
      }
    },
    [channelId, showToast],
  );
  const voice = useVoiceRecorder((clip) => void sendVoice(clip));
  const recording = voice.state !== "idle" || sendingVoice;

  function startRecording() {
    voice.start().catch((err: unknown) => {
      showToast(
        err instanceof DOMException
          ? mediaErrorText(err, "microphone")
          : "Couldn't start recording.",
      );
    });
  }

  function submit() {
    if (!canSend) return;
    chat.sendMessage(channelId, text.trim(), ready, replyTo);
    if (replyTo) setReplyTo(channelId, null);
    setText("");
    setUploads((list) => list.filter((u) => !u.attachment));
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      setReplyTo(channelId, null);
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
        {replyTo && (
          <div
            className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm"
            aria-label="Replying to a message"
          >
            <ReplyIcon className="shrink-0 text-primary" />
            <p className="min-w-0 flex-1 truncate text-ink-secondary">
              Replying to <strong className="text-ink">{nameOf(replyTo.userId)}</strong>
              {": "}
              {replyTo.preview || (replyTo.hasAttachments ? "📎 Attachment" : "")}
            </p>
            <button
              type="button"
              onClick={() => setReplyTo(channelId, null)}
              aria-label="Cancel reply"
              title="Cancel reply (Esc)"
              className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            >
              <CloseIcon />
            </button>
          </div>
        )}
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
                  aria-label={`Remove ${u.file.name}`}
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
          {recording ? (
            <RecordingBar
              elapsed={voice.elapsed}
              level={voice.level}
              sending={sendingVoice || voice.state === "starting"}
              onCancel={voice.cancel}
              onSend={() => void voice.stop().then(sendVoice)}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                aria-label="Attach file"
                title={`Attach (max. ${MAX_SIZE_LABEL})`}
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
              <button
                type="button"
                onClick={(e) => setEmojiAnchor(emojiAnchor ? null : e.currentTarget)}
                disabled={disabled}
                className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                aria-label="Insert emoji"
                title="Emoji"
              >
                <SmileIcon />
              </button>
              {emojiAnchor && (
                <Popover anchor={emojiAnchor} onClose={() => setEmojiAnchor(null)}>
                  <EmojiPicker
                    onSelect={(emoji) => {
                      insertAtCursor(emoji);
                      setEmojiAnchor(null);
                    }}
                  />
                </Popover>
              )}
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
                aria-label="Message"
                className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-1 py-2 text-base text-ink placeholder:text-ink-secondary/80 focus:outline-none disabled:cursor-not-allowed sm:text-sm"
              />
              {voiceSupported && (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={disabled || inCall}
                  className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                  aria-label="Record a voice message"
                  title={inCall ? "Not available during a call" : "Voice message"}
                >
                  <MicIcon />
                </button>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                className="btn-primary h-9 w-9 p-0"
                aria-label="Send"
                title={uploading ? "Waiting for uploads to finish" : "Send (Enter)"}
              >
                <SendIcon />
              </button>
            </>
          )}
        </div>
      </div>
      <p className="mt-1 hidden px-1 text-[11px] text-ink-secondary sm:block">
        <b>Enter</b> to send · <b>Shift + Enter</b> for a new line · **bold** _italic_ `code`
      </p>
    </div>
  );
});
