import type { AskChannelResponse, NewsChatTurn } from "@mindfultech/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { renderMessageMarkdown } from "../lib/markdown";
import { request } from "../lib/tasksApi";
import { Modal } from "./Modal";
import { SparklesIcon } from "./icons";

// ---------------------------------------------------------------------------
// Phase 68: the conversation's AI companion. Ask it about this chat ("¿qué
// queda pendiente?"); it reads the conversation's messages on the server and
// answers. The questions of this session are kept per conversation until the
// page is reloaded.
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  "¿Qué queda pendiente y quién lo tiene?",
  "Resume lo más importante de esta semana",
  "¿Qué decisiones o aprobaciones se tomaron?",
  "¿Qué me falta responder?",
];

interface Turn extends NewsChatTurn {
  read?: number;
}
const sessions = new Map<string, Turn[]>();

export function ChannelAssistant({
  channelId,
  title,
  onClose,
}: Readonly<{ channelId: string; title: string; onClose: () => void }>) {
  const [turns, setTurns] = useState<Turn[]>(() => sessions.get(channelId) ?? []);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessions.set(channelId, turns);
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [channelId, turns, asking]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || asking) return;
    setError(null);
    setAsking(true);
    setQuestion("");
    const history = turns.slice(-10).map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: q }]);
    try {
      const { answer, read } = await request<AskChannelResponse>(
        "POST",
        `/channels/${encodeURIComponent(channelId)}/ask`,
        { question: q, history },
      );
      setTurns((t) => [...t, { role: "assistant", content: answer, read }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo responder ahora.");
      setTurns((t) => t.slice(0, -1));
      setQuestion(q);
    } finally {
      setAsking(false);
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };

  return (
    <Modal title={`IA de ${title}`} width="lg" onClose={onClose}>
      <div className="flex max-h-[65dvh] min-h-[18rem] flex-col gap-3" data-channel-assistant>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <div className="space-y-3">
              <p className="flex items-start gap-2 text-sm text-ink-secondary">
                <SparklesIcon className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                Pregúntame sobre esta conversación: leo sus mensajes (hilos incluidos) y te respondo
                con lo que dicen.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-full border border-primary/40 px-3 py-1.5 text-left text-xs font-medium text-ink hover:bg-primary/10"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <p
                key={i}
                className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary/20 px-3 py-2 text-sm text-ink"
              >
                {turn.content}
              </p>
            ) : (
              <div key={i} className="max-w-[95%] space-y-1">
                <div
                  className="message-markdown rounded-2xl rounded-bl-md border border-line bg-surface-sidebar px-3 py-2 text-sm leading-relaxed text-ink"
                  // Safe: the renderer escapes all HTML before adding its own tags.
                  dangerouslySetInnerHTML={{ __html: renderMessageMarkdown(turn.content).html }}
                />
                {turn.read !== undefined && (
                  <p className="px-1 text-[11px] text-ink-secondary">
                    Según {turn.read} {turn.read === 1 ? "mensaje" : "mensajes"} de este chat
                  </p>
                )}
              </div>
            ),
          )}
          {asking && (
            <p className="flex items-center gap-2 text-sm text-ink-secondary" role="status">
              <SparklesIcon className="animate-pulse text-primary" aria-hidden="true" />
              Leyendo la conversación…
            </p>
          )}
          <div ref={bottom} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <form onSubmit={submit} className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(question);
              }
            }}
            rows={2}
            maxLength={1000}
            placeholder="Pregunta sobre este chat…"
            aria-label="Pregunta para la IA"
            className="input min-h-[2.75rem] flex-1 resize-none text-sm"
          />
          <button type="submit" className="btn-primary" disabled={asking || !question.trim()}>
            Preguntar
          </button>
        </form>
      </div>
    </Modal>
  );
}
