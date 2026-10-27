import { isDmChannel, MAX_TEXT_LENGTH } from "@mindfultech/shared";
import {
  applyCommand,
  commandQuery,
  matchCommands,
  parseCommand,
  type SlashCommand,
} from "../lib/commands";
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
import { useCall } from "../lib/call";
import { chat } from "../lib/chat";
import { clearDraft, createDraftSaver, draftKey, loadDraft } from "../lib/drafts";
import { mediaErrorText } from "../lib/media";
import {
  formatDuration,
  MAX_VOICE_MS,
  supportsVoiceMessages,
  useVoiceRecorder,
  type VoiceClip,
} from "../lib/voice";
import { detectCredentials } from "../lib/credentials";
import { useUploadState, type UploadTask } from "../lib/outbox";
import { formatBytes, MAX_SIZE_LABEL, startUpload, validateFile } from "../lib/upload";
import { MOBILE_QUERY, useMediaQuery } from "../lib/hooks";
import { useChat, useNameOf } from "../store";
import { EmojiPicker } from "./EmojiPicker";
import {
  CloseIcon,
  FileIcon,
  ArchiveIcon,
  CalendarIcon,
  LockIcon,
  MicIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  ReplyIcon,
  SendIcon,
  SmileIcon,
  TrashIcon,
} from "./icons";
import { Modal } from "./Modal";
import { Popover } from "./Popover";
import { ScheduleMeetingModal } from "./ScheduleMeetingModal";

/** A file attached to the next message: its name, size, and how its upload is going. */
function UploadChip({ task, onRemove }: Readonly<{ task: UploadTask; onRemove: () => void }>) {
  const { progress, attachment, error } = useUploadState(task);
  const { file } = task;
  return (
    <li
      className={`relative flex w-52 items-center gap-2 overflow-hidden rounded-lg border bg-surface-sidebar px-2 py-1.5 ${
        error ? "border-error" : "border-line"
      }`}
      data-upload
    >
      {task.previewUrl ? (
        <img
          src={task.previewUrl}
          alt=""
          className="h-8 w-8 shrink-0 rounded object-cover"
          aria-hidden="true"
        />
      ) : (
        <FileIcon className="shrink-0 text-ink-secondary" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-ink" title={file.name}>
          {file.name}
        </p>
        <p className="text-[11px] text-ink-secondary" aria-live="polite">
          {error
            ? `${error} It will be tried again when you send.`
            : attachment
              ? formatBytes(file.size)
              : `Uploading… ${Math.round(progress * 100)} % of ${formatBytes(file.size)}`}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
        aria-label={`Remove ${file.name}`}
      >
        <CloseIcon />
      </button>
      {!attachment && !error && (
        <span
          role="progressbar"
          aria-label={`Uploading ${file.name}`}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="absolute bottom-0 left-0 h-1 bg-primary transition-all"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      )}
    </li>
  );
}

export interface ComposerHandle {
  addFiles: (files: FileList | File[]) => void;
}

interface ComposerProps {
  channelId: string;
  placeholder: string;
  disabled?: boolean;
  /** Posts into this message's thread instead of the channel. */
  thread?: { messageId: string; sk: string };
  /** Archived channel: a banner instead of the input. */
  readOnly?: boolean;
}

const MAX_HEIGHT_PX = 200;
/** Shorter recordings are a slip of the finger, not a message. */
const MIN_VOICE_MS = 500;
/** Typed at the start of a message, turns secret mode on (and is dropped from the text). */
const SECRET_COMMAND = /^\/secret(\s|$)/i;

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
  { channelId, placeholder, disabled = false, thread, readOnly = false },
  ref,
) {
  const showToast = useChat((s) => s.showToast);
  const userId = useChat((s) => s.me?.userId);
  // This composer's unsent text survives switching away and reloads (see lib/drafts).
  const storageKey = userId ? draftKey(userId, channelId, thread?.sk) : null;
  const [text, setText] = useState(() => (storageKey ? loadDraft(storageKey) : ""));
  // Files attached to the next message, already uploading (Phase 39: never waited on).
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  // Phones (Phase 37): Slack's pill, with attach/emoji/meeting/secret behind "+".
  const phone = useMediaQuery(MOBILE_QUERY);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [addSheet, setAddSheet] = useState(false);
  const replyTo = useChat((s) => s.replyTo[channelId]);
  const inCall = useCall((s) => s.call !== null);
  const voiceSupported = useMemo(supportsVoiceMessages, []);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const editing = useChat((s) => s.editing[channelId]);
  const setEditing = useChat((s) => s.setEditing);
  const nameOf = useNameOf();
  /** Secret mode: the message is sent masked, text only, and deleted after 24 hours. */
  const [secret, setSecret] = useState(false);
  // "Send as normal text" on the auto-detect hint: this message isn't a credential.
  const [plainAnyway, setPlainAnyway] = useState(false);
  // Direct messages: schedule a meeting with the other person from here.
  const [scheduling, setScheduling] = useState(false);
  const dm = isDmChannel(channelId) && !thread;
  // Phase 36: meetings can be scheduled into channels too.
  const canSchedule = !thread;

  // Another conversation, or editing: back to a normal message.
  useEffect(() => setSecret(false), [channelId]);
  useEffect(() => {
    if (editing) setSecret(false);
  }, [editing]);

  // Drafts: saved shortly after typing stops, written at once when the composer
  // goes (another conversation, the thread closing) or the page does.
  const saver = useMemo(() => (storageKey ? createDraftSaver(storageKey) : null), [storageKey]);
  useEffect(() => {
    if (!saver) return;
    const onHide = () => saver.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      saver.flush();
    };
  }, [saver]);
  // Signed in after mounting (a cold start): the draft arrives with the user.
  useEffect(() => {
    if (storageKey) setText((current) => current || loadDraft(storageKey));
  }, [storageKey]);
  useEffect(() => {
    if (!saver || !storageKey) return;
    // Editing a sent message isn't a draft: keep the one from before the edit
    // (restored on cancel). A secret never goes to disk in clear.
    if (editing) return saver.flush();
    if (secret) {
      saver.cancel();
      return clearDraft(storageKey);
    }
    // Sending or clearing empties the input, which forgets the draft at once.
    saver.schedule(text);
  }, [saver, storageKey, text, editing, secret]);

  // Starting a reply (swipe, or Reply in the toolbar) puts the cursor here.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // Editing: the old text replaces whatever was typed, caret at the end; a pending reply is dropped.
  useEffect(() => {
    if (!editing) return;
    setText(editing.text);
    setReplyTo(channelId, null);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [editing, channelId, setReplyTo]);

  function cancelEdit() {
    setEditing(channelId, null);
    // Back to what was being typed before the edit began.
    setText(storageKey ? loadDraft(storageKey) : "");
  }

  /** ↑ in an empty composer: edit your newest message (with text) in this channel. */
  function editLastOwnMessage() {
    const { me, messagesByChannel } = useChat.getState();
    const own = [...(messagesByChannel[channelId] ?? [])]
      .reverse()
      .find((m) => m.userId === me?.userId && !m.status && m.text);
    if (own) setEditing(channelId, { sk: own.sk, messageId: own.messageId, text: own.text });
  }

  // Slash commands: typing `/` at the start opens the list, filtered as you type.
  const commandText = editing ? null : commandQuery(text);
  const commands = useMemo(
    () => (commandText === null ? [] : matchCommands(commandText)),
    [commandText],
  );
  const [commandIndex, setCommandIndex] = useState(0);
  useEffect(() => setCommandIndex(0), [commandText]);
  const commandOpen = commands.length > 0;

  function pickCommand(command: SlashCommand) {
    if (command.effect === "secret") {
      setSecret(true);
      setText("");
    } else if (command.effect === "clear") {
      setText("");
    } else {
      setText(`/${command.name} `);
    }
    textareaRef.current?.focus();
  }

  function handleChange(value: string) {
    // `/secret ` at the start is the keyboard's lock button.
    if (!editing && SECRET_COMMAND.test(value)) {
      setSecret(true);
      value = value.replace(SECRET_COMMAND, "");
    }
    setText(value);
    // Keystrokes with content (not deletions to empty) tell the channel you're typing.
    if (value.trim() && !editing) chat.typing(channelId);
  }

  function toggleSecret() {
    setSecret((on) => !on);
    textareaRef.current?.focus();
  }

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

  // Never waits for uploads: the outbox sends the message once its files are up.
  // A secret is text only: files wait until secret mode is off.
  const canSend = !disabled && (text.trim().length > 0 || (uploads.length > 0 && !secret));

  // Auto-grow up to MAX_HEIGHT_PX.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  // Files attached but never sent (the composer closed) give their local copies back.
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  useEffect(() => () => uploadsRef.current.forEach((u) => u.dispose()), []);

  function removeUpload(task: UploadTask) {
    task.dispose();
    setUploads((list) => list.filter((u) => u !== task));
  }

  function addFiles(files: FileList | File[]) {
    if (disabled) return;
    for (const file of Array.from(files)) {
      const invalid = validateFile(file);
      if (invalid) {
        showToast(`${file.name}: ${invalid}`);
        continue;
      }
      const task = startUpload(file, channelId);
      setUploads((list) => [...list, task]);
    }
  }

  useImperativeHandle(ref, () => ({ addFiles }));

  // Shows at once and uploads in the background, like any other message (Phase 39).
  const sendVoice = useCallback(
    (clip: VoiceClip | null) => {
      if (!clip) return;
      if (clip.durationMs < MIN_VOICE_MS) {
        showToast("Too short: hold on a little longer.");
        return;
      }
      const task = startUpload(clip.file, channelId, {
        durationMs: Math.max(1, Math.round(clip.durationMs)),
      });
      chat.sendMessage(channelId, "", [task], useChat.getState().replyTo[channelId]);
      useChat.getState().setReplyTo(channelId, null);
    },
    [channelId, showToast],
  );
  const voice = useVoiceRecorder(sendVoice);
  const recording = voice.state !== "idle";

  if (readOnly) {
    return (
      <div
        className="mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-2 rounded-xl border border-line bg-surface-sidebar px-4 py-3 text-sm text-ink-secondary"
        role="status"
      >
        <ArchiveIcon /> This channel is archived. You can read it, but not post.
      </div>
    );
  }

  function startRecording() {
    voice.start().catch((err: unknown) => {
      showToast(
        err instanceof DOMException
          ? mediaErrorText(err, "microphone")
          : "Couldn't start recording.",
      );
    });
  }

  /**
   * Looks like a password or key (`detectCredentials`): sent as a secret unless
   * the person says it isn't. Not for files or thread replies (secrets are text
   * only, and never replies), nor a slash command.
   */
  const autoSecret = useMemo(
    () =>
      !secret &&
      !editing &&
      !thread &&
      !disabled &&
      uploads.length === 0 &&
      !text.trimStart().startsWith("/") &&
      detectCredentials(text),
    [secret, editing, thread, disabled, uploads.length, text],
  );
  // A new message gets checked anew.
  useEffect(() => {
    if (!text.trim()) setPlainAnyway(false);
  }, [text]);

  function submit() {
    if (editing) {
      const next = text.trim();
      if (!next || disabled) return;
      if (next !== editing.text) chat.editMessage(channelId, editing.sk, next);
      cancelEdit();
      textareaRef.current?.focus();
      return;
    }
    if (!canSend) return;
    // A complete command on the line (`/shrug hi`): its effect, not the slash text.
    const command = !secret ? parseCommand(text) : null;
    let outgoing = text.trim();
    let asSecret = secret;
    if (command?.command.effect === "secret") {
      asSecret = true;
      outgoing = command.rest.trim();
      if (!outgoing) return;
    } else if (command) {
      outgoing = applyCommand(command.command, command.rest);
      if (!outgoing && uploads.length === 0) {
        setText("");
        return;
      }
    }
    // A credential typed as a normal message goes out as a secret anyway.
    const detected = !command && autoSecret && !plainAnyway;
    if (detected) asSecret = true;
    chat.sendMessage(
      channelId,
      outgoing,
      asSecret ? [] : uploads,
      thread ? undefined : replyTo,
      asSecret,
      thread,
    );
    if (replyTo) setReplyTo(channelId, null);
    setText("");
    setPlainAnyway(false);
    if (detected) {
      showToast("Sent as a secret: it looked like a password. It's deleted in 24 hours.", "info");
    }
    if (secret) setSecret(false);
    else {
      uploadsRef.current = []; // the outbox has them now: not this composer's to free
      setUploads([]);
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setCommandIndex((i) => (i + delta + commands.length) % commands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(commands[commandIndex] ?? commands[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      setReplyTo(channelId, null);
    } else if (e.key === "Escape" && secret) {
      e.preventDefault();
      setSecret(false);
    } else if (e.key === "ArrowUp" && !text && !editing && !e.nativeEvent.isComposing) {
      e.preventDefault();
      editLastOwnMessage();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  }

  const fileInput = (
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
  );
  const pickers = (
    <>
      {scheduling && (
        <ScheduleMeetingModal channelId={channelId} onClose={() => setScheduling(false)} />
      )}
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
    </>
  );
  const textarea = (
    <textarea
      ref={textareaRef}
      rows={1}
      value={text}
      maxLength={MAX_TEXT_LENGTH}
      onChange={(e) => handleChange(e.target.value)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={secret ? "Password or API key (deleted in 24 hours)" : placeholder}
      disabled={disabled}
      aria-label={secret ? "Secret" : "Message"}
      className={`max-h-[200px] flex-1 resize-none bg-transparent text-base text-ink focus:outline-none disabled:cursor-not-allowed ${
        phone
          ? "min-h-[40px] px-1 py-2 text-[17px] placeholder:text-ink-secondary"
          : "min-h-[36px] px-1 py-2 placeholder:text-ink-secondary/80 sm:text-sm"
      }`}
    />
  );
  const sendButton = (
    <button
      type="button"
      onClick={submit}
      disabled={editing ? !text.trim() : !canSend}
      className={
        phone
          ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-lg text-on-primary disabled:opacity-40"
          : "btn-primary h-9 w-9 p-0"
      }
      aria-label={editing ? "Save changes" : "Send"}
      title={editing ? "Save (Enter)" : "Send (Enter)"}
    >
      <SendIcon />
    </button>
  );
  const micButton = voiceSupported && (
    <button
      type="button"
      onClick={startRecording}
      disabled={disabled || inCall || !!editing || secret}
      className={
        phone
          ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[24px] text-ink active:bg-surface-hover disabled:opacity-40"
          : "rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
      }
      aria-label="Record a voice message"
      title={inCall ? "Not available during a call" : "Voice message"}
    >
      <MicIcon />
    </button>
  );
  // Phones: the mic until there's something to send (Slack's way).
  const typed = text.trim().length > 0 || uploads.length > 0 || !!editing || secret;

  return (
    <div
      className={
        phone
          ? "bg-surface px-3 pb-2 pt-1.5"
          : "border-t border-line bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4 sm:pb-3"
      }
      data-composer
    >
      <div
        className={
          phone
            ? "overflow-hidden rounded-[26px] border border-line bg-surface-raised focus-within:border-primary/60"
            : "rounded-xl border border-line bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30"
        }
      >
        {editing && (
          <div
            className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm"
            aria-label="Editing a message"
          >
            <PencilIcon className="shrink-0 text-primary" />
            <p className="min-w-0 flex-1 truncate text-ink-secondary">
              Editing message · <b>Enter</b> to save
            </p>
            <button
              type="button"
              onClick={cancelEdit}
              aria-label="Cancel editing"
              title="Cancel editing (Esc)"
              className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            >
              <CloseIcon />
            </button>
          </div>
        )}
        {secret && !editing && (
          <div
            className="flex items-center gap-2 border-b border-line bg-warning/10 px-3 py-2 text-sm"
            aria-label="Sending a secret"
          >
            <LockIcon className="shrink-0 text-warning" />
            <p className="min-w-0 flex-1 truncate text-ink-secondary">
              <strong className="text-ink">Secret:</strong> shown as ••••••• until revealed, and
              deleted after 24 hours. Text only.
            </p>
            <button
              type="button"
              onClick={() => setSecret(false)}
              aria-label="Send as a normal message"
              title="Send as a normal message (Esc)"
              className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            >
              <CloseIcon />
            </button>
          </div>
        )}
        {autoSecret && !plainAnyway && (
          <div
            className="flex items-center gap-2 border-b border-line bg-warning/10 px-3 py-2 text-sm"
            role="status"
            data-auto-secret
          >
            <LockIcon className="shrink-0 text-warning" />
            <p className="min-w-0 flex-1 text-ink-secondary">
              <strong className="text-ink">Looks like a password:</strong> it will be sent as a
              secret, masked and deleted after 24 hours.
            </p>
            <button
              type="button"
              onClick={() => {
                setPlainAnyway(true);
                textareaRef.current?.focus();
              }}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-hover hover:text-ink"
              data-send-plain
            >
              Send as normal text
            </button>
          </div>
        )}
        {replyTo && !editing && (
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
            {uploads.map((task) => (
              <UploadChip key={task.id} task={task} onRemove={() => removeUpload(task)} />
            ))}
          </ul>
        )}

        {commandOpen && (
          <ul
            role="listbox"
            aria-label="Slash commands"
            className="mx-1.5 mb-1 overflow-hidden rounded-lg glass-strong border border-white/10"
          >
            {commands.map((c, i) => (
              <li key={c.name} role="option" aria-selected={i === commandIndex}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickCommand(c)}
                  onMouseEnter={() => setCommandIndex(i)}
                  className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                    i === commandIndex ? "bg-surface-hover" : ""
                  }`}
                >
                  <span className="font-mono font-semibold text-ink">/{c.name}</span>
                  {c.usage && <span className="text-xs text-ink-secondary">{c.usage}</span>}
                  <span className="ml-auto truncate text-xs text-ink-secondary">
                    {c.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={`flex items-end gap-1 ${phone ? "p-1" : "p-1.5"}`}>
          {recording ? (
            <RecordingBar
              elapsed={voice.elapsed}
              level={voice.level}
              sending={voice.state === "starting"}
              onCancel={voice.cancel}
              onSend={() => void voice.stop().then(sendVoice)}
            />
          ) : phone ? (
            <>
              <button
                ref={plusRef}
                type="button"
                onClick={() => setAddSheet(true)}
                disabled={disabled}
                aria-label="Add to message"
                aria-haspopup="dialog"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[22px] text-ink disabled:opacity-40"
              >
                <PlusIcon />
              </button>
              {pickers}
              {addSheet && (
                <Modal title="Add to message" width="sm" onClose={() => setAddSheet(false)}>
                  <div className="-mx-5 -my-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                    {/* Its own input: the page behind the sheet is inert. */}
                    <label
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-hover ${
                        editing || secret ? "pointer-events-none opacity-40" : "cursor-pointer"
                      }`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-xl text-ink">
                        <PaperclipIcon />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-semibold text-ink">
                          Photo or file
                        </span>
                        <span className="block text-sm text-ink-secondary">
                          Up to {MAX_SIZE_LABEL}
                        </span>
                      </span>
                      <input
                        type="file"
                        multiple
                        className="sr-only"
                        disabled={!!editing || secret}
                        aria-label="Attach a photo or file"
                        onChange={(e) => {
                          if (e.target.files) addFiles(e.target.files);
                          setAddSheet(false);
                        }}
                      />
                    </label>
                    {[
                      {
                        key: "emoji",
                        icon: <SmileIcon />,
                        label: "Emoji",
                        off: false,
                        run: () => setEmojiAnchor(plusRef.current),
                      },
                      ...(canSchedule
                        ? [
                            {
                              key: "meeting",
                              icon: <CalendarIcon />,
                              label: "Schedule a meeting",
                              hint: dm ? "Goes to both calendars" : "Posted in this channel",
                              off: !!editing,
                              run: () => setScheduling(true),
                            },
                          ]
                        : []),
                      {
                        key: "secret",
                        icon: <LockIcon />,
                        label: secret ? "Send as a normal message" : "Send a secret",
                        hint: "Masked until revealed, deleted in 24 hours",
                        off: !!editing,
                        run: toggleSecret,
                      },
                    ].map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        disabled={item.off}
                        onClick={() => {
                          item.run();
                          setAddSheet(false);
                        }}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-hover disabled:opacity-40"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-xl text-ink">
                          {item.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-semibold text-ink">
                            {item.label}
                          </span>
                          {item.hint && (
                            <span className="block text-sm text-ink-secondary">{item.hint}</span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </Modal>
              )}
              {textarea}
              {typed || !micButton ? sendButton : micButton}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={toggleSecret}
                disabled={disabled || !!editing}
                aria-pressed={secret}
                className={`rounded-lg p-2 hover:bg-surface-hover disabled:opacity-50 ${
                  secret ? "bg-warning/15 text-warning" : "text-ink-secondary hover:text-ink"
                }`}
                aria-label={secret ? "Secret mode on" : "Send a secret"}
                title={
                  secret ? "Secret: sent masked, deleted in 24 hours" : "Send a secret (/secret)"
                }
              >
                <LockIcon />
              </button>
              {canSchedule && (
                <button
                  type="button"
                  onClick={() => setScheduling(true)}
                  disabled={disabled || !!editing}
                  className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                  aria-label="Schedule meeting"
                  title={
                    dm
                      ? "Schedule a meeting (goes to both calendars)"
                      : "Schedule a meeting in this channel"
                  }
                >
                  <CalendarIcon />
                </button>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || !!editing || secret}
                className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                aria-label="Attach file"
                title={`Attach (max. ${MAX_SIZE_LABEL})`}
              >
                <PaperclipIcon />
              </button>
              {fileInput}
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
              {pickers}
              {textarea}
              {micButton}
              {sendButton}
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
