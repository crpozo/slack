import { describe, expect, it, vi } from "vitest";
import type { NewsChatApi } from "../lib/newsApi";
import { createNewsChatStore, historyFor } from "./newsChat";

const source = { n: 2, title: "AWS", link: "https://infoq.com/a", sourceName: "InfoQ" };

describe("news chat store", () => {
  it("asks with the chat so far and adds the answer with its sources", async () => {
    const ask = vi
      .fn<NewsChatApi["ask"]>()
      .mockResolvedValueOnce({ answer: "AWS agotó su capacidad [2].", sources: [source] })
      .mockResolvedValueOnce({ answer: "Plan de cuotas.", sources: [] });
    const store = createNewsChatStore({ ask });
    await store.getState().ask("  ¿Qué pasó con AWS?  ");
    await store.getState().ask("¿Y qué hacemos?");
    expect(ask.mock.calls[0]![0]).toEqual({ question: "¿Qué pasó con AWS?", history: [] });
    expect(ask.mock.calls[1]![0]).toEqual({
      question: "¿Y qué hacemos?",
      history: [
        { role: "user", content: "¿Qué pasó con AWS?" },
        { role: "assistant", content: "AWS agotó su capacidad [2]." },
      ],
    });
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "¿Qué pasó con AWS?"],
      ["assistant", "AWS agotó su capacidad [2]."],
      ["user", "¿Y qué hacemos?"],
      ["assistant", "Plan de cuotas."],
    ]);
    expect(store.getState().messages[1]!.sources).toEqual([source]);
    await store.getState().ask("   ");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed question to retry; a new question replaces it instead", async () => {
    const ask = vi
      .fn<NewsChatApi["ask"]>()
      .mockRejectedValueOnce(new Error("No se pudo responder ahora."))
      .mockResolvedValueOnce({ answer: "Ahora sí.", sources: [] })
      .mockRejectedValueOnce(new Error("otra vez"))
      .mockResolvedValueOnce({ answer: "Otra.", sources: [] });
    const store = createNewsChatStore({ ask });
    await store.getState().ask("Primera");
    expect(store.getState()).toMatchObject({ asking: false, error: "No se pudo responder ahora." });
    await store.getState().retry();
    expect(ask.mock.calls[1]![0]).toEqual({ question: "Primera", history: [] });
    expect(store.getState().messages.map((m) => m.content)).toEqual(["Primera", "Ahora sí."]);

    await store.getState().ask("Segunda");
    await store.getState().ask("Tercera"); // replaces the unanswered "Segunda"
    expect(store.getState().messages.map((m) => m.content)).toEqual([
      "Primera",
      "Ahora sí.",
      "Tercera",
      "Otra.",
    ]);
    store.getState().clear();
    expect(store.getState().messages).toEqual([]);
  });

  it("sends at most the last 10 turns, each cut to 4,000 characters", () => {
    const messages = Array.from({ length: 14 }, (_, i) => ({
      id: i,
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: "x".repeat(5_000),
    }));
    const history = historyFor(messages);
    expect(history).toHaveLength(10);
    expect(history.every((t) => t.content.length === 4_000)).toBe(true);
  });
});
