import { MAX_NEWS_QUESTION_LENGTH } from "@mindfultech/shared";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { renderNotesMarkdown } from "../lib/markdown";
import { linkCitations } from "../lib/newsDashboard";
import { useNewsChat, type NewsChatMessage } from "../store/newsChat";
import { CloseIcon, RefreshIcon, SendIcon, SparklesIcon, TrashIcon } from "./icons";
import { useModalDialog } from "./Modal";

/** What to ask when the chat is empty: one tap sends it. */
const SUGGESTIONS = [
  "¿Cuál es la noticia más importante de hoy y por qué?",
  "¿Qué deberíamos probar o hacer esta semana en MindfulTech?",
  "¿Qué noticias afectan a nuestros clientes?",
  "Resume las tendencias en 3 puntos.",
];

/**
 * "Pregunta a la IA" (Phase 50): a chat about today's news, answered by
 * Claude Haiku 5.5 from the stories and the morning's analysis, citing the
 * stories it relies on (each a link to the article). The chat stays while
 * you move around the app; "Clear" starts over.
 */
export function NewsChat({
  storyCount,
  onClose,
}: Readonly<{ storyCount: number; onClose?: () => void }>) {
  const { messages, asking, error, ask, retry, clear } = useNewsChat();
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Newest at the bottom, in view.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, asking, error]);

  function send(text: string) {
    const question = text.trim();
    if (!question || asking) return;
    setDraft("");
    void ask(question);
    input.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  }

  const lastUnanswered = messages.at(-1)?.role === "user";

  return (
    <section
      aria-label="Pregunta a la IA"
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] focus:outline-none border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.03] shadow-[0_14px_40px_rgb(0_0_0/0.3),inset_0_1px_0_rgb(255_255_255/0.06)]"
      data-news-chat
    >
      <header className="flex items-center gap-2.5 border-b border-white/10 px-4 py-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 text-primary"
          aria-hidden="true"
        >
          <SparklesIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-ink">Pregunta a la IA</h2>
          <p className="truncate text-[11px] text-ink-secondary">
            Sobre las {storyCount} historias de hoy y su análisis
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            aria-label="Borrar la conversación"
            title="Borrar la conversación"
          >
            <TrashIcon />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
            aria-label="Cerrar"
            data-close
          >
            <CloseIcon />
          </button>
        )}
      </header>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-secondary">
              Pregunta lo que quieras sobre las noticias de hoy: qué significan, cómo se relacionan,
              qué hacer con ellas. La IA cita las historias en las que se basa.
            </p>
            <ul className="flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => send(s)}
                    disabled={asking}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-[13px] text-ink/85 transition hover:border-primary/50 hover:bg-primary/[0.08] disabled:opacity-60"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((m) => (
              <li key={m.id}>
                <ChatMessage message={m} />
              </li>
            ))}
          </ol>
        )}
        {asking && (
          <div className="mt-4 flex items-center gap-2 text-xs text-ink-secondary" role="status">
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
            </span>
            Pensando sobre las noticias…
          </div>
        )}
        {error && !asking && (
          <div
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink"
          >
            <span className="min-w-0 flex-1">{error}</span>
            {lastUnanswered && (
              <button
                type="button"
                onClick={() => void retry()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold hover:bg-white/10"
              >
                <RefreshIcon aria-hidden="true" /> Reintentar
              </button>
            )}
          </div>
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <label className="sr-only" htmlFor="news-chat-input">
          Tu pregunta
        </label>
        <textarea
          id="news-chat-input"
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={MAX_NEWS_QUESTION_LENGTH}
          placeholder="Pregunta sobre las noticias…"
          className="input max-h-32 min-h-[40px] min-w-0 flex-1 resize-none py-2 text-base [field-sizing:content] sm:text-sm"
        />
        <button
          type="submit"
          disabled={asking || !draft.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary transition hover:bg-primary/90 disabled:opacity-40"
          aria-label="Enviar pregunta"
          title="Enviar (Enter)"
        >
          <SendIcon />
        </button>
      </form>
    </section>
  );
}

function ChatMessage({ message }: Readonly<{ message: NewsChatMessage }>) {
  const html = useMemo(
    () =>
      message.role === "assistant"
        ? linkCitations(renderNotesMarkdown(message.content), message.sources ?? [])
        : "",
    [message],
  );
  if (message.role === "user") {
    return (
      <div className="ml-8 rounded-2xl rounded-br-sm bg-primary/20 px-3 py-2 text-sm text-ink [overflow-wrap:anywhere]">
        {message.content}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div
        className="md md-notes text-sm leading-relaxed text-ink/90 [overflow-wrap:anywhere]"
        // Safe: renderNotesMarkdown escapes all text; linkCitations only adds escaped https links.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {message.sources && message.sources.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Fuentes">
          {message.sources.map((s) => (
            <li key={s.n}>
              <a
                href={s.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[11px] text-ink-secondary hover:bg-white/[0.05] hover:text-ink"
              >
                <span className="news-cite !mx-0">{s.n}</span>
                <span className="shrink-0 font-semibold">{s.sourceName}</span>
                <span className="truncate">{s.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Phones and narrow windows: a floating "Preguntar" button that opens the
 * chat as a sheet. (Wide windows show the chat beside the news instead.)
 */
export function NewsChatLauncher({ storyCount }: Readonly<{ storyCount: number }>) {
  const [open, setOpen] = useState(false);
  const count = useNewsChat((s) => s.messages.length);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-30 inline-flex items-center gap-2 rounded-full border border-primary/50 bg-primary px-4 py-3 text-sm font-semibold text-on-primary shadow-[0_8px_28px_rgb(0_0_0/0.45),0_0_24px_rgb(64_179_117/0.35)] transition active:scale-95 md:bottom-[max(1.25rem,env(safe-area-inset-bottom))] md:right-5 xl:hidden"
        aria-haspopup="dialog"
        data-news-chat-launcher
      >
        <SparklesIcon aria-hidden="true" />
        Pregunta a la IA
        {count > 0 && (
          <span className="rounded-full bg-black/20 px-1.5 text-xs tabular-nums">{count}</span>
        )}
      </button>
      {open && <ChatSheet storyCount={storyCount} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChatSheet({ storyCount, onClose }: Readonly<{ storyCount: number; onClose: () => void }>) {
  const dialog = useModalDialog(onClose);
  // The dialog focuses its first button on opening (Clear): start on the chat instead.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("[data-news-chat]")?.focus();
  }, [dialog]);
  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Pregunta a la IA"
      // Phones: a sheet from the bottom, the dynamic viewport's height so the
      // field stays above the keyboard; wider: a centered panel.
      className="m-0 mt-auto h-[92dvh] max-h-none w-full max-w-full bg-transparent p-0 backdrop:bg-scrim/50 backdrop:backdrop-blur-sm sm:m-auto sm:h-[80dvh] sm:max-w-lg sm:p-2"
    >
      <div className="h-full overflow-hidden rounded-t-[18px] bg-surface sm:rounded-[18px]">
        <NewsChat storyCount={storyCount} onClose={onClose} />
      </div>
    </dialog>,
    document.body,
  );
}
