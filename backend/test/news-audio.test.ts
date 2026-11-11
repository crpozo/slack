import { describe, expect, it } from "vitest";
import {
  AUDIO_BUDGET_CHARS,
  audioScript,
  scriptChunks,
  spokenDay,
  spokenSeconds,
} from "../src/lib/newsAudio";

describe("the AI News summary in audio (Phase 54)", () => {
  const insights = {
    day: "2026-11-09",
    stories: [
      {
        headline: "OpenAI lanza agentes",
        summary: "Resumen.",
        whyItMatters: "Cambia la **automatización** de procesos",
        sourceName: "TechCrunch",
        link: "https://techcrunch.com/a",
        thumbnailUrl: null,
        pubDate: null,
      },
      {
        headline: "Nvidia invierte",
        summary: "Una ronda grande. Ver https://example.com",
        sourceName: "The Verge",
        link: "https://theverge.com/b",
        thumbnailUrl: null,
        pubDate: null,
      },
    ],
    trends: [{ topic: "Agentes", text: "Todos lanzan **agentes** para empresas" }],
    takeaways: [
      { lead: "Probar agentes", body: "en un cliente actual.", horizon: "ahora" as const },
    ],
  };

  it("reads the day and the top stories in a sentence each: no trends, actions, markdown or links", () => {
    const script = audioScript(insights);
    expect(script.split("\n\n")).toEqual([
      "AI News, lunes, 9 de noviembre. Lo más importante en un minuto.",
      "Primero: OpenAI lanza agentes. Resumen.",
      // Only the first sentence of what happened; links dropped.
      "Segundo: Nvidia invierte. Una ronda grande.",
      "Los detalles, en AI News.",
    ]);
    expect(script).not.toMatch(/\*\*|https?:|Por qué importa|Fuente/);
  });

  it("fits a minute: as many stories as the budget takes, always the first", () => {
    const long = {
      ...insights.stories[0]!,
      headline: "Un titular largo sobre inteligencia artificial que ocupa bastante",
      summary: `${"palabra ".repeat(40).trim()}. Segunda frase que no se lee.`,
    };
    const script = audioScript({ ...insights, stories: [long, long, long, long, long] });
    expect(script.length).toBeLessThanOrEqual(AUDIO_BUDGET_CHARS + 20);
    expect(script).toContain("Primero:");
    expect(script).not.toContain("Quinto");
    expect(script).not.toContain("Segunda frase");
    // One enormous story is still read.
    const huge = { ...long, summary: `${"x".repeat(1200)}.` };
    expect(audioScript({ ...insights, stories: [huge, long] })).toContain("Primero:");
  });

  it("says a new Claude model first (Phase 56)", () => {
    const script = audioScript({
      ...insights,
      claudeAlert: {
        status: "launched",
        model: "Claude Opus 6",
        headline: "h",
        summary: "Disponible hoy en la API.",
        evidence: [],
        from: "analysis",
      },
    });
    const [, second] = script.split("\n\n");
    expect(second).toBe(
      "Atención: Anthropic lanzó un nuevo modelo de Claude: Claude Opus 6. Disponible hoy en la API.",
    );
  });

  it("cuts the script into pieces Polly accepts, between paragraphs then sentences", () => {
    const script = ["Uno. Dos.", "Tres.", "x".repeat(25) + ". " + "y".repeat(25) + "."].join(
      "\n\n",
    );
    const chunks = scriptChunks(script, 30);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, "")).toBe(script.replace(/\s+/g, ""));
    expect(scriptChunks("corto")).toEqual(["corto"]);
  });

  it("names the day in Spanish and guesses how long it plays", () => {
    expect(spokenDay("2026-11-09")).toBe("lunes, 9 de noviembre");
    expect(spokenDay("nope")).toBe("");
    expect(spokenSeconds(1500)).toBe(100);
  });
});
