import {
  MAX_NEWS_CHAT_HISTORY,
  MAX_NEWS_CHAT_TURN_LENGTH,
  type NewsChatTurn,
  type NewsCitation,
} from "@mindfultech/shared";
import { create } from "zustand";
import { newsChatApi, type NewsChatApi } from "../lib/newsApi";

/** One message of the chat: a question, or an answer with the stories it cites. */
export interface NewsChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  sources?: NewsCitation[];
}

/**
 * "Pregunta a la IA" (Phase 50): the chat about today's news. It lives for
 * the tab (leaving AI News and coming back keeps it), never on the server:
 * each question sends the turns before it.
 */
export interface NewsChatState {
  messages: NewsChatMessage[];
  /** A question is waiting for its answer. */
  asking: boolean;
  /** Why the last question got no answer (it stays in the chat, to ask again). */
  error: string | null;
  ask: (question: string) => Promise<void>;
  /** Asks the last unanswered question again. */
  retry: () => Promise<void>;
  clear: () => void;
}

/** The turns sent with a question: the latest ones, each cut to what the server accepts. */
export function historyFor(messages: NewsChatMessage[]): NewsChatTurn[] {
  return messages
    .slice(-MAX_NEWS_CHAT_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_NEWS_CHAT_TURN_LENGTH) }));
}

export function createNewsChatStore(api: NewsChatApi) {
  let nextId = 1;
  return create<NewsChatState>((set, get) => {
    async function send(question: string, earlier: NewsChatMessage[]) {
      set({ asking: true, error: null });
      try {
        const { answer, sources } = await api.ask({ question, history: historyFor(earlier) });
        set((s) => ({
          asking: false,
          messages: [...s.messages, { id: nextId++, role: "assistant", content: answer, sources }],
        }));
      } catch (err) {
        set({
          asking: false,
          error: err instanceof Error && err.message ? err.message : "No se pudo responder.",
        });
      }
    }
    return {
      messages: [],
      asking: false,
      error: null,
      ask: async (raw) => {
        const question = raw.trim();
        if (!question || get().asking) return;
        // The chat so far: answered turns only (an unanswered question is replaced by this one).
        const earlier = get().messages.filter(
          (m, i, all) => m.role === "assistant" || all[i + 1]?.role === "assistant",
        );
        set({ messages: [...earlier, { id: nextId++, role: "user", content: question }] });
        await send(question, earlier);
      },
      retry: async () => {
        const { messages, asking } = get();
        const last = messages.at(-1);
        if (asking || last?.role !== "user") return;
        await send(last.content, messages.slice(0, -1));
      },
      clear: () => set({ messages: [], error: null }),
    };
  });
}

export const useNewsChat = createNewsChatStore(newsChatApi);
