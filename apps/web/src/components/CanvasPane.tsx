import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { formatDay, formatTime } from "../lib/channels";
import { useChat, useNameOf } from "../store";
import { useCanvas } from "../store/canvas";
import {
  ArrowDownIcon,
  BoldIcon,
  CloseIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  RedoIcon,
  StrikethroughIcon,
  UndoIcon,
} from "./icons";

/** Typing pauses this long before the canvas is saved. */
export const AUTOSAVE_MS = 1500;

/**
 * The conversation's canvas beside the chat (Phase 24): a rich-text document
 * (TipTap) that everyone in the channel can edit. It saves itself whole
 * after a pause in typing and on blur; a save based on a version someone
 * else replaced is refused, the editor reloads theirs and says so (last
 * writer wins, no merging). Another person's save arrives as a push and
 * reloads the editor when it has nothing unsaved. Read-only in an archived
 * channel.
 */
export function CanvasPane({
  channelId,
  title,
  readOnly,
  onClose,
}: Readonly<{
  channelId: string;
  title: string;
  readOnly: boolean;
  onClose: () => void;
}>) {
  const canvas = useCanvas((s) => s.canvases[channelId]);
  const status = useCanvas((s) => s.status[channelId] ?? "idle");
  const load = useCanvas((s) => s.load);
  const save = useCanvas((s) => s.save);
  const showToast = useChat((s) => s.showToast);
  const nameOf = useNameOf();
  const myUserId = useChat((s) => s.me?.userId);
  // Unsaved local changes, and the server version the editor currently shows.
  const dirty = useRef(false);
  const shown = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void load(channelId);
  }, [channelId, load]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"] },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: readOnly
            ? "This channel is archived: its canvas can't be edited."
            : "Write the channel's notes, plan or spec here. Everyone in it can edit.",
        }),
      ],
      content: "",
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: "canvas-editor focus:outline-none",
          "aria-label": `Canvas of ${title}`,
        },
      },
      onUpdate: () => {
        dirty.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
      },
      onBlur: () => void flush(),
    },
    [channelId, readOnly],
  );
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const ed = editorRef.current;
    if (!dirty.current || !ed || ed.isDestroyed) return;
    dirty.current = false;
    const result = await save(channelId, ed.getHTML());
    if (result === "conflict") {
      const current = useCanvas.getState().canvases[channelId];
      if (current && !ed.isDestroyed) {
        ed.commands.setContent(current.content, { emitUpdate: false });
        shown.current = current.version;
      }
      showToast(
        `${current ? nameOf(current.updatedBy) : "Someone"} saved the canvas meanwhile. It was reloaded with their version.`,
      );
    } else if (result === "error") {
      dirty.current = true; // kept locally: the next pause tries again
    }
  }, [channelId, save, showToast, nameOf]);

  // The server's version into the editor: on load, and on someone else's save
  // while nothing here is unsaved (a dirty editor keeps typing; its save will
  // conflict and reload then).
  useEffect(() => {
    if (!editor || !canvas || editor.isDestroyed) return;
    if (shown.current === canvas.version) return;
    if (dirty.current && shown.current !== null) return;
    editor.commands.setContent(canvas.content, { emitUpdate: false });
    shown.current = canvas.version;
  }, [editor, canvas]);

  // Leaving the pane saves what's pending.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const ed = editorRef.current;
      if (dirty.current && ed && !ed.isDestroyed) {
        dirty.current = false;
        void save(channelId, ed.getHTML());
      }
    },
    [channelId, save],
  );

  const statusLine = (() => {
    if (status === "loading" && !canvas) return "Loading…";
    if (status === "saving") return "Saving…";
    if (status === "error") return "Couldn't save. Retrying when you pause.";
    if (!canvas || canvas.version === 0) return readOnly ? "Empty" : "Not saved yet";
    const who = canvas.updatedBy === myUserId ? "you" : nameOf(canvas.updatedBy);
    const day = formatDay(canvas.updatedAt);
    const when = day === "Today" ? formatTime(canvas.updatedAt) : day;
    return `${status === "saved" ? "Saved" : "Edited"} by ${who} · ${when}`;
  })();

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Canvas">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Back to the chat"
        >
          <ArrowDownIcon className="rotate-90" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold leading-tight text-ink">Canvas</h2>
          <p className="truncate text-xs leading-tight text-ink-secondary" aria-live="polite">
            {statusLine}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="hidden rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:block"
          aria-label="Close the canvas"
        >
          <CloseIcon />
        </button>
      </header>
      {editor && !readOnly && <Toolbar editor={editor} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8">
        <EditorContent editor={editor} className="min-h-full" />
      </div>
    </section>
  );
}

function ToolButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: Readonly<{
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      // mousedown would blur the editor (and save) before the command runs.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base disabled:opacity-40 ${
        active
          ? "bg-primary/20 text-ink"
          : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** The formatting bar; `useEditorState` re-renders it as the selection moves. */
function Toolbar({ editor }: Readonly<{ editor: Editor }>) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      tasks: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      code: e.isActive("codeBlock"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const run = () => editor.chain().focus();

  function setLink() {
    const previous = (editor.getAttributes("link") as { href?: string }).href ?? "";
    const url = window.prompt("Link to", previous);
    if (url === null) return;
    if (!url.trim()) return run().extendMarkRange("link").unsetLink().run();
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    run().extendMarkRange("link").setLink({ href }).run();
  }

  const divider = <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 py-1"
    >
      <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => run().undo().run()}>
        <UndoIcon />
      </ToolButton>
      <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => run().redo().run()}>
        <RedoIcon />
      </ToolButton>
      {divider}
      <ToolButton
        label="Heading 1"
        active={state.h1}
        onClick={() => run().toggleHeading({ level: 1 }).run()}
      >
        <Heading1Icon />
      </ToolButton>
      <ToolButton
        label="Heading 2"
        active={state.h2}
        onClick={() => run().toggleHeading({ level: 2 }).run()}
      >
        <Heading2Icon />
      </ToolButton>
      {divider}
      <ToolButton label="Bold" active={state.bold} onClick={() => run().toggleBold().run()}>
        <BoldIcon />
      </ToolButton>
      <ToolButton label="Italic" active={state.italic} onClick={() => run().toggleItalic().run()}>
        <ItalicIcon />
      </ToolButton>
      <ToolButton
        label="Strikethrough"
        active={state.strike}
        onClick={() => run().toggleStrike().run()}
      >
        <StrikethroughIcon />
      </ToolButton>
      <ToolButton label="Link" active={state.link} onClick={setLink}>
        <LinkIcon />
      </ToolButton>
      {divider}
      <ToolButton
        label="Bulleted list"
        active={state.bullet}
        onClick={() => run().toggleBulletList().run()}
      >
        <ListIcon />
      </ToolButton>
      <ToolButton
        label="Numbered list"
        active={state.ordered}
        onClick={() => run().toggleOrderedList().run()}
      >
        <ListOrderedIcon />
      </ToolButton>
      <ToolButton
        label="Checklist"
        active={state.tasks}
        onClick={() => run().toggleTaskList().run()}
      >
        <ListChecksIcon />
      </ToolButton>
      {divider}
      <ToolButton label="Quote" active={state.quote} onClick={() => run().toggleBlockquote().run()}>
        <QuoteIcon />
      </ToolButton>
      <ToolButton
        label="Code block"
        active={state.code}
        onClick={() => run().toggleCodeBlock().run()}
      >
        <CodeIcon />
      </ToolButton>
    </div>
  );
}
